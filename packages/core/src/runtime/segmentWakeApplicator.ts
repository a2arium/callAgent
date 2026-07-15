/**
 * Applies a segment wake to a task snapshot before TurnRunner.runTurn.
 *
 * Mirrors the snapshot-mutation steps TaskEngine performs in resumeInput /
 * handleToolCompleted / handleChildCompleted / handleExternalEventOccurred,
 * without the scheduling side-effects (outbox, auto-resume, LoopRegistry).
 *
 * INTERNAL — not exported from the public package index.
 */

import { applyInputProvided } from '../orchestration/DurableHandlerRegistry.js';
import {
    getPendingExternalEvents,
    setPendingExternalEvents,
} from '../orchestration/ExternalEventsRegistry.js';
import { InboxManager, type EngineObservation } from '../orchestration/InboxManager.js';
import type { SessionManager } from '../orchestration/SessionManager.js';
import { getPendingTools, setPendingTools } from '../orchestration/ToolsRegistry.js';
import { TaskStateUtils } from '../orchestration/utils/TaskStateUtils.js';
import type { TurnExecutionParams, TurnTrigger as TurnRunnerTrigger } from '../orchestration/TurnRunner.js';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { ArtifactHydrationService } from '../orchestration/ArtifactHydrationService.js';
import { prepareChildResultForPersistence } from '../orchestration/childResultPersistence.js';
import {
    childTerminalEventPayload,
    claimChildTerminalInSnapshot,
    getChildTerminal,
    type ChildTerminalClaim,
} from '../orchestration/ChildTerminalCoordinator.js';
import type { ConversationPayload } from '../types/observation.js';
import type { TurnWake } from './turnExecutor.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { makeSafeEventPreview } from '../orchestration/safeEventPreview.js';

export type PreparedSegmentWake = {
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    agentId: string;
    trigger: TurnRunnerTrigger;
    /** Extra fields passed through to TurnRunner.runTurn (beyond tenant/session/trigger). */
    turnParams: Partial<TurnExecutionParams>;
    /** Token expiry surfaced for await_input boundary mapping. */
    inputExpiresAt?: string;
    /** Losing terminal workers persist nothing and must not run another parent turn. */
    skipTurn?: boolean;
    childTerminalClaim?: ChildTerminalClaim;
};

function agentIdFromSnapshot(snapshot: Record<string, unknown>, fallback?: string): string {
    const fromMeta = (snapshot.meta as { agentId?: string } | undefined)?.agentId;
    return fromMeta ?? fallback ?? 'default';
}

function turnFromSnapshot(snapshot: Record<string, unknown>): number {
    return Number((snapshot.meta as { turn?: number } | undefined)?.turn ?? 0);
}

function observationProvenance(token: string, turn: number, toolId?: string): EngineObservation['provenance'] {
    return {
        ts: Date.now(),
        turn: turn + 1,
        id: token,
        ...(toolId !== undefined ? { toolId } : {}),
        correlationId: token,
    };
}

/** Pure: apply a wake to an in-memory snapshot (no persist). */
export function applyWakeToSnapshot(
    base: Record<string, unknown>,
    wake: TurnWake,
    opts?: { tenantId?: string; taskId?: string; agentId?: string; hydrateChildResult?: (result: unknown) => void }
): PreparedSegmentWake {
    switch (wake.trigger) {
        case 'start':
            return {
                snapshot: base,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(base, opts?.agentId),
                trigger: 'start',
                turnParams: { input: wake.input },
            };

        case 'resume': {
            if (wake.event.kind !== 'input') {
                throw new Error(`resume wake expects input event, got ${wake.event.kind}`);
            }
            const pendingBefore = (base as { pending?: { inputs?: Record<string, { expiresAt?: string }> } })
                .pending?.inputs;
            const inputExpiresAt = pendingBefore?.[wake.event.token]?.expiresAt;
            const { next } = applyInputProvided(base, wake.event.token, wake.event.value, {
                tenantId: opts?.tenantId,
                taskId: opts?.taskId,
                agentId: opts?.agentId ?? agentIdFromSnapshot(base),
            });
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'resume',
                turnParams: { input: wake.event.value },
                inputExpiresAt,
            };
        }

        case 'tool': {
            const event = wake.event;
            if (event.kind !== 'tool') {
                throw new Error(`tool wake expects tool event, got ${event.kind}`);
            }
            const tools = { ...getPendingTools(base) };
            const entry = tools[event.token];
            if (entry !== undefined) {
                delete tools[event.token];
            }
            let next = setPendingTools(base, tools);
            const observation: EngineObservation = {
                source: 'tool',
                kind: 'tool.completed',
                payload: { token: event.token, result: event.result, tool: entry?.name },
                provenance: observationProvenance(event.token, turnFromSnapshot(base), entry?.name),
            };
            next = {
                ...next,
                inbox: InboxManager.addObservationToInbox((next as { inbox?: unknown }).inbox, observation),
            };
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'tool',
                turnParams: { toolToken: event.token, toolResult: event.result },
            };
        }

        case 'child': {
            const event = wake.event;
            if (event.kind !== 'child') {
                throw new Error(`child wake expects child event, got ${event.kind}`);
            }
            if (event.terminalClaimed === true) {
                const terminal = getChildTerminal(base, event.token);
                const inbox = InboxManager.normalizeInbox((base as { inbox?: unknown }).inbox);
                const hasTerminalObservation = inbox.all.some(
                    (candidate) =>
                        (candidate.kind === 'child.completed' || candidate.kind === 'child.failed') &&
                        (candidate.payload as { token?: unknown } | undefined)?.token === event.token
                );
                return {
                    snapshot: base,
                    wmVersion: BigInt(0),
                    agentId: agentIdFromSnapshot(base, opts?.agentId),
                    trigger: 'resume',
                    turnParams: {},
                    skipTurn: terminal === undefined || !hasTerminalObservation,
                };
            }
            const failedEnvelope = event.output as { ok?: unknown; error?: unknown } | undefined;
            const failed = event.outcome === 'failed' || failedEnvelope?.ok === false;
            if (!failed) opts?.hydrateChildResult?.(event.output);
            const clean = failed ? undefined : TaskStateUtils.extractCleanChildResult(event.output);
            const rawError = event.error ?? failedEnvelope?.error;
            const normalizedError =
                rawError !== null && typeof rawError === 'object' && !Array.isArray(rawError)
                    ? {
                          code: typeof (rawError as any).code === 'string' ? (rawError as any).code : 'CHILD_FAILED',
                          message:
                              typeof (rawError as any).message === 'string'
                                  ? (rawError as any).message
                                  : String(rawError),
                          ...(typeof (rawError as any).timeoutMs === 'number'
                              ? { timeoutMs: (rawError as any).timeoutMs }
                              : {}),
                      }
                    : { code: 'CHILD_FAILED', message: String(rawError ?? 'Child failed.') };
            const claim = claimChildTerminalInSnapshot(
                base,
                failed
                    ? {
                          kind: 'failed',
                          token: event.token,
                          failedAt: event.completedAt ?? new Date().toISOString(),
                          childTaskId: event.childTaskId,
                          error: normalizedError,
                      }
                    : {
                          kind: 'completed',
                          token: event.token,
                          completedAt: event.completedAt ?? new Date().toISOString(),
                          childTaskId: clean?.childTaskId ?? event.childTaskId,
                          result: clean?.result,
                          executionMetadata: clean?.executionMetadata,
                      }
            );
            return {
                snapshot: claim.snapshot,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(claim.snapshot, opts?.agentId),
                trigger: 'resume',
                turnParams: {},
                skipTurn: !claim.won,
                childTerminalClaim: claim,
            };
        }

        case 'event': {
            const event = wake.event;
            if (event.kind !== 'external') {
                throw new Error(`event wake expects external event, got ${event.kind}`);
            }
            const events = { ...getPendingExternalEvents(base) };
            const entry = events[event.token];
            if (entry !== undefined) {
                delete events[event.token];
            }
            let next = setPendingExternalEvents(base, events);
            const observation: EngineObservation = {
                source: 'env',
                kind: 'external.event',
                payload: { token: event.token, payload: event.data, type: event.type },
                provenance: observationProvenance(event.token, turnFromSnapshot(base)),
            };
            next = {
                ...next,
                inbox: InboxManager.addObservationToInbox((next as { inbox?: unknown }).inbox, observation),
            };
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'event',
                turnParams: {
                    eventToken: event.token,
                    eventType: event.type,
                    eventPayload: event.data,
                },
            };
        }

        case 'timer': {
            const event = wake.event;
            if (event.kind !== 'timer') {
                throw new Error(`timer wake expects timer event, got ${event.kind}`);
            }
            if (event.reason === 'child_timeout') {
                const payload =
                    event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
                        ? (event.payload as Record<string, unknown>)
                        : {};
                const timeoutMs = typeof payload.timeoutMs === 'number'
                    ? payload.timeoutMs
                    : Math.max(0, Date.parse(event.dueAt) - Date.parse(event.firedAt));
                const claim = claimChildTerminalInSnapshot(base, {
                    kind: 'failed',
                    token: event.token,
                    failedAt: event.firedAt,
                    childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : undefined,
                    agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
                    error: {
                        code: 'CHILD_TIMEOUT',
                        message: `Child call timed out after ${timeoutMs}ms for token ${event.token}.`,
                        timeoutMs,
                    },
                });
                return {
                    snapshot: claim.snapshot,
                    wmVersion: BigInt(0),
                    agentId: agentIdFromSnapshot(claim.snapshot, opts?.agentId),
                    trigger: 'resume',
                    turnParams: {},
                    skipTurn: !claim.won,
                    childTerminalClaim: claim,
                };
            }
            const observation: EngineObservation = {
                source: 'env',
                kind: 'timer.expired',
                payload: {
                    token: event.token,
                    timerId: event.timerId,
                    dueAt: event.dueAt,
                    firedAt: event.firedAt,
                    reason: event.reason,
                    ...(event.payload !== undefined ? { payload: event.payload } : {}),
                },
                provenance: observationProvenance(event.token, turnFromSnapshot(base)),
            };
            let timerBase = base;
            if (event.reason === 'input_timeout') {
                const pending = { ...((base as any).pending ?? {}) };
                const inputs = { ...(pending.inputs ?? {}) };
                delete inputs[event.token];
                const manifestConsents = { ...(pending.manifestConsents ?? {}) };
                const receipt = manifestConsents[event.token];
                if (receipt?.status === 'pending') {
                    manifestConsents[event.token] = { ...receipt, status: 'expired', decidedAt: event.firedAt };
                }
                timerBase = { ...base, pending: { ...pending, inputs, manifestConsents } };
            }
            const next = {
                ...timerBase,
                inbox: InboxManager.addObservationToInbox((timerBase as { inbox?: unknown }).inbox, observation),
            };
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'event',
                turnParams: {
                    eventToken: event.token,
                    eventType: 'timer.expired',
                    eventPayload: event.payload,
                },
            };
        }

        case 'conversation': {
            const event = wake.event;
            if (event.kind !== 'conversation') {
                throw new Error(`conversation wake expects conversation event, got ${event.kind}`);
            }
            const payload = event.data as ConversationPayload;
            const observation = {
                source: 'conversation',
                kind: payload.kind,
                payload,
                provenance: observationProvenance(event.token, turnFromSnapshot(base)),
            } as EngineObservation;
            const next = {
                ...base,
                inbox: InboxManager.addObservationToInbox((base as { inbox?: unknown }).inbox, observation),
            };
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'conversation',
                turnParams: {},
            };
        }
    }
}

function hydrateChildWakeOutput(
    sessionManager: SessionManager,
    tenantId: string
): ((result: unknown) => void) | undefined {
    const prisma = (sessionManager as unknown as { store?: { prisma?: unknown } }).store?.prisma;
    if (!prisma) {
        return undefined;
    }
    const cache = new AgentResultCache(prisma as any);
    return (result: unknown) => {
        ArtifactHydrationService.tryHydrateChildResult(result, cache, tenantId);
    };
}

/**
 * Load snapshot, apply wake, persist when needed, return prepared state for runTurn.
 */
export async function prepareSegmentWake(
    sessionManager: SessionManager,
    params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        wake: TurnWake;
    }
): Promise<PreparedSegmentWake> {
    const { tenantId, taskId, agentId, wake } = params;

    if (wake.trigger === 'start') {
        const existing = await sessionManager.load(tenantId, taskId);
        const base = (existing?.snapshot as Record<string, unknown> | undefined) ?? {
            meta: { agentId: agentId ?? 'default', turn: 0 },
        };
        const prepared = applyWakeToSnapshot(base, wake, { tenantId, taskId, agentId });
        if (existing === null || existing === undefined) {
            await sessionManager.saveSnapshot({
                tenantId,
                sessionId: taskId,
                agentId: prepared.agentId,
                expectedWmVersion: BigInt(0),
                snapshot: prepared.snapshot,
            });
        }
        return { ...prepared, wmVersion: existing?.wmVersion ?? BigInt(0) };
    }

    const completedAt = wake.trigger === 'child' && wake.event.kind === 'child'
        ? wake.event.completedAt ?? new Date().toISOString()
        : undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const snap = await sessionManager.load(tenantId, taskId);
        if (snap === null || snap === undefined) {
            throw new Error(`Session not found for ${taskId}`);
        }
        const base = (snap.snapshot as Record<string, unknown>) || {};
        let wakeToApply = wake;
        if (wake.trigger === 'child' && wake.event.kind === 'child') {
            const failed = wake.event.outcome === 'failed' || (wake.event.output as any)?.ok === false;
            const prisma = (sessionManager as unknown as { store?: { prisma?: unknown } }).store?.prisma;
            const cache = prisma ? new AgentResultCache(prisma as any) : undefined;
            const output = failed
                ? wake.event.output
                : await prepareChildResultForPersistence(wake.event.output, cache, tenantId);
            wakeToApply = {
                ...wake,
                event: { ...wake.event, output, completedAt },
            };
        }
        const prepared = applyWakeToSnapshot(base, wakeToApply, {
            tenantId,
            taskId,
            agentId,
            hydrateChildResult: wakeToApply.trigger === 'child' ? hydrateChildWakeOutput(sessionManager, tenantId) : undefined,
        });
        if (prepared.skipTurn) {
            if (
                prepared.childTerminalClaim?.lateCompletion === true &&
                wakeToApply.trigger === 'child' &&
                wakeToApply.event.kind === 'child' &&
                wakeToApply.event.outcome !== 'failed'
            ) {
                defaultMetricsRegistry.increment('child.late_completion_total', {
                    source: 'segment_wake',
                });
                await sessionManager.appendEvent(
                    tenantId,
                    taskId,
                    'task.child_late_completion',
                    {
                        token: wakeToApply.event.token,
                        childTaskId: wakeToApply.event.childTaskId,
                        completedAt: wakeToApply.event.completedAt ?? completedAt,
                        resultPreview: makeSafeEventPreview(wakeToApply.event.output),
                    }
                );
            }
            return { ...prepared, wmVersion: snap.wmVersion ?? BigInt(0) };
        }
        try {
            const saveResult = await sessionManager.saveSnapshot({
                tenantId,
                sessionId: taskId,
                agentId: prepared.agentId,
                expectedWmVersion: snap.wmVersion ?? BigInt(0),
                snapshot: prepared.snapshot,
            });
            if (saveResult === null) throw new Error('CAS_MISMATCH');
            const eventPayload = childTerminalEventPayload(prepared.childTerminalClaim ?? { snapshot: prepared.snapshot, won: false });
            if (eventPayload !== undefined && typeof (sessionManager as any).appendEvent === 'function') {
                const eventType = prepared.childTerminalClaim?.kind === 'failed'
                    ? 'task.child_failed'
                    : 'task.child_completed';
                await sessionManager.appendEvent(tenantId, taskId, eventType, eventPayload);
                defaultMetricsRegistry.increment('child.terminal_race_winner_total', {
                    kind: prepared.childTerminalClaim?.kind ?? 'unknown',
                });
                if (prepared.childTerminalClaim?.terminal?.error?.code === 'CHILD_TIMEOUT') {
                    defaultMetricsRegistry.increment('child.timeout_total', {
                        source: wakeToApply.trigger === 'timer' ? 'timer' : 'completion',
                    });
                }
            }
            return { ...prepared, wmVersion: snap.wmVersion ?? BigInt(0) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if ((message === 'CAS_MISMATCH' || message === 'WM_VERSION_CONFLICT') && attempt < 5) continue;
            throw error;
        }
    }
    throw new Error('CAS_MISMATCH');
}
