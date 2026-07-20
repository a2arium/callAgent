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
import { throwInvariantError } from '../utils/invariantError.js';
import {
    getPendingExternalEvents,
    setPendingExternalEvents,
} from '../orchestration/ExternalEventsRegistry.js';
import { InboxManager, type EngineObservation } from '../orchestration/InboxManager.js';
import type { SessionManager } from '../orchestration/SessionManager.js';
import {
    claimToolTerminalInSnapshot,
    detachPendingToolsInSnapshot,
    type ToolTerminalClaim,
} from '../orchestration/ToolTerminalCoordinator.js';
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
import { reconcileSnapshotMutation } from '../orchestration/persistence/SnapshotRepository.js';
import { logger } from '@a2arium/callagent-utils';
import {
    isTaskLifecycleTerminal,
    markTaskLifecycle,
    readTaskLifecycle,
} from '../orchestration/TaskLifecycle.js';
import { getPendingTasks, setPendingTasks } from '../orchestration/Handles.js';

const log = logger.createLogger({ prefix: 'SegmentWakeApplicator' });

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
    toolTerminalClaim?: ToolTerminalClaim;
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
    opts?: { tenantId?: string; taskId?: string; agentId?: string; storageNow?: string; hydrateChildResult?: (result: unknown) => void }
): PreparedSegmentWake {
    switch (wake.trigger) {
        case 'start':
            {
            const meta = base.meta !== null && typeof base.meta === 'object' && !Array.isArray(base.meta)
                ? base.meta as Record<string, unknown>
                : {};
            const next = {
                ...base,
                meta: {
                    ...meta,
                    agentId: opts?.agentId ?? meta.agentId ?? 'default',
                    initialInput: wake.input,
                },
            };
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                trigger: 'start',
                turnParams: { input: wake.input },
            };
            }

        case 'resume': {
            if (wake.event.kind !== 'input') {
                throw new Error(`resume wake expects input event, got ${wake.event.kind}`);
            }
            const pendingBefore = (base as { pending?: { inputs?: Record<string, { expiresAt?: string }> } })
                .pending?.inputs;
            const pendingInput = pendingBefore?.[wake.event.token];
            if (pendingInput === undefined) {
                throwInvariantError(
                    'INPUT_TOKEN_NOT_FOUND',
                    `Input token ${wake.event.token} not found`,
                    { type: 'token_validation', category: 'input', token: wake.event.token, reason: 'missing' }
                );
            }
            if (pendingInput.expiresAt !== undefined &&
                Date.parse(pendingInput.expiresAt) <= Date.parse(opts?.storageNow ?? new Date().toISOString())) {
                throwInvariantError(
                    'INPUT_TOKEN_EXPIRED',
                    `Input token ${wake.event.token} expired`,
                    { type: 'token_validation', category: 'input', token: wake.event.token, reason: 'expired' }
                );
            }
            const inputExpiresAt = pendingInput.expiresAt;
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
            const claim = claimToolTerminalInSnapshot(base, {
                token: event.token,
                completedAt: new Date().toISOString(),
                result: event.result,
                taskId: opts?.taskId ?? 'unknown',
            });
            return {
                snapshot: claim.snapshot,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(claim.snapshot, opts?.agentId),
                trigger: 'tool',
                turnParams: { toolToken: event.token, toolResult: event.result },
                skipTurn: !claim.resumeEligible,
                toolTerminalClaim: claim,
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
                skipTurn: claim.publicationDisposition !== 'new_delivery' &&
                    claim.publicationDisposition !== 'matching_replay',
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
            if (entry === undefined) {
                throwInvariantError(
                    'EXTERNAL_EVENT_TOKEN_NOT_FOUND',
                    `External event token ${event.token} not found`,
                    { type: 'token_validation', category: 'event', token: event.token, reason: 'missing' }
                );
            }
            const eventType = typeof entry.type === 'string' ? entry.type : event.type;
            delete events[event.token];
            let next = setPendingExternalEvents(base, events);
            const observation: EngineObservation = {
                source: 'env',
                kind: 'external.event',
                payload: { token: event.token, payload: event.data, type: eventType },
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
                    eventType,
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

async function reconcileTerminalAncestor(
    sessionManager: SessionManager,
    tenantId: string,
    taskId: string
): Promise<void> {
    const owner = await sessionManager.load(tenantId, taskId);
    const ownerSnapshot = (owner?.snapshot as Record<string, unknown> | undefined) ?? {};
    const ownerLifecycle = readTaskLifecycle(ownerSnapshot, taskId);
    if (ownerLifecycle === undefined || isTaskLifecycleTerminal(ownerLifecycle)) return;
    const ancestorIds = [...new Set([
        ...ownerLifecycle.ancestorTaskIds,
        ownerLifecycle.parentTaskId,
        ownerLifecycle.rootTaskId,
    ].filter((value): value is string => typeof value === 'string' && value !== taskId))];
    let terminalAncestor: ReturnType<typeof readTaskLifecycle>;
    for (const ancestorTaskId of ancestorIds) {
        const ancestor = await sessionManager.load(tenantId, ancestorTaskId);
        const lifecycle = readTaskLifecycle(ancestor?.snapshot, ancestorTaskId);
        if (isTaskLifecycleTerminal(lifecycle)) {
            terminalAncestor = lifecycle;
            break;
        }
    }
    if (terminalAncestor === undefined) return;
    const detachedAt = new Date().toISOString();
    const reason = `ancestor_${terminalAncestor.state}`;
    const reconciled = await reconcileSnapshotMutation({
        session: sessionManager,
        tenantId,
        sessionId: taskId,
        operation: 'task.lineage.detach',
        mutate: ({ snapshot }) => {
            const lifecycle = readTaskLifecycle(snapshot, taskId);
            if (isTaskLifecycleTerminal(lifecycle)) {
                return { kind: 'noop', value: [] as ReturnType<typeof detachPendingToolsInSnapshot>['detached'] };
            }
            const marked = markTaskLifecycle(snapshot, {
                taskId,
                state: 'detached',
                changedAt: detachedAt,
                reason,
                rootTaskId: lifecycle?.rootTaskId,
                parentTaskId: lifecycle?.parentTaskId,
                ancestorTaskIds: lifecycle?.ancestorTaskIds,
            });
            const tools = detachPendingToolsInSnapshot(marked, { taskId, reason, detachedAt });
            return { kind: 'write', snapshot: tools.snapshot, value: tools.detached };
        },
    });
    if (reconciled.status !== 'committed') return;
    for (const terminal of reconciled.value) {
        defaultMetricsRegistry.increment('tool.terminal_winner_total', { kind: 'detached' });
        try {
            await sessionManager.appendEvent(tenantId, taskId, 'task.tool_detached', {
                token: terminal.token,
                toolName: terminal.toolName,
                reason,
                detachedAt,
            });
        } catch { /* diagnostic only */ }
    }
}

async function reconcileTerminalOwnerEffects(
    sessionManager: SessionManager,
    tenantId: string,
    taskId: string
): Promise<void> {
    const detachedAt = new Date().toISOString();
    await reconcileSnapshotMutation({
        session: sessionManager,
        tenantId,
        sessionId: taskId,
        operation: 'task.terminal_effects.recover',
        mutate: ({ snapshot, wmVersion }) => {
            if (wmVersion === BigInt(0) && Object.keys(snapshot).length === 0) {
                return { kind: 'noop', value: undefined };
            }
            const lifecycle = readTaskLifecycle(snapshot, taskId);
            if (!isTaskLifecycleTerminal(lifecycle)) {
                return { kind: 'noop', value: undefined };
            }
            const tools = detachPendingToolsInSnapshot(snapshot, {
                taskId,
                reason: lifecycle!.reason ?? `task_${lifecycle!.state}`,
                detachedAt,
            });
            const tasks = getPendingTasks(tools.snapshot);
            const pending = (tools.snapshot as any).pending ?? {};
            const childTerminals = {
                ...((pending.childTerminals ?? {}) as Record<string, unknown>),
            } as Record<string, any>;
            for (const [token, entry] of Object.entries(tasks)) {
                childTerminals[token] ??= {
                    kind: 'failed',
                    claimedAt: detachedAt,
                    ...(entry.childTaskId !== undefined ? { childTaskId: entry.childTaskId } : {}),
                    ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
                    error: {
                        code: 'CHILD_OWNER_TERMINAL',
                        message: `Child result delivery detached because owner task ${taskId} is terminal.`,
                    },
                };
            }
            if (tools.detached.length === 0 && Object.keys(tasks).length === 0) {
                return { kind: 'noop', value: undefined };
            }
            const withoutTasks = setPendingTasks(tools.snapshot, {});
            return {
                kind: 'write',
                value: undefined,
                snapshot: {
                    ...withoutTasks,
                    pending: {
                        ...((withoutTasks as any).pending ?? {}),
                        childTerminals,
                    },
                },
            };
        },
    });
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
        await reconcileTerminalOwnerEffects(sessionManager, tenantId, taskId);
        const reconciled = await reconcileSnapshotMutation({
            session: sessionManager,
            tenantId,
            sessionId: taskId,
            operation: 'segment.start.prepare',
            agentId,
            mutate: ({ snapshot, wmVersion }) => {
                const exists = wmVersion > BigInt(0) || Object.keys(snapshot).length > 0;
                const base = exists ? snapshot : { meta: { agentId: agentId ?? 'default', turn: 0 } };
                if (exists && isTaskLifecycleTerminal(readTaskLifecycle(base, taskId))) {
                    return {
                        kind: 'noop',
                        value: {
                            snapshot: base,
                            wmVersion,
                            agentId: agentIdFromSnapshot(base, agentId),
                            trigger: 'start' as const,
                            turnParams: {},
                            skipTurn: true,
                        },
                    };
                }
                const prepared = applyWakeToSnapshot(base, wake, { tenantId, taskId, agentId });
                return exists
                    ? { kind: 'noop', value: prepared }
                    : { kind: 'write', snapshot: prepared.snapshot, value: prepared };
            },
        });
        return { ...reconciled.value, wmVersion: reconciled.wmVersion };
    }

    await reconcileTerminalAncestor(sessionManager, tenantId, taskId);
    await reconcileTerminalOwnerEffects(sessionManager, tenantId, taskId);

    const completedAt = wake.trigger === 'child' && wake.event.kind === 'child'
        ? wake.event.completedAt ?? new Date().toISOString()
        : undefined;
    const reconciled = await reconcileSnapshotMutation({
        session: sessionManager,
        tenantId,
        sessionId: taskId,
        operation: `segment.${wake.trigger}.apply`,
        agentId,
        mutate: async ({ snapshot: base, wmVersion }) => {
            if (wmVersion === BigInt(0) && Object.keys(base).length === 0) {
                throw new Error(`Session not found for ${taskId}`);
            }
        if (wake.trigger !== 'tool' && isTaskLifecycleTerminal(readTaskLifecycle(base, taskId))) {
            const prepared: PreparedSegmentWake = {
                snapshot: base,
                wmVersion,
                agentId: agentIdFromSnapshot(base, agentId),
                trigger: 'resume',
                turnParams: {},
                skipTurn: true,
            };
            return { kind: 'noop', value: { prepared, wakeToApply: wake } };
        }
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
            const terminalAlreadyClaimed = wakeToApply.trigger === 'child' &&
                wakeToApply.event.kind === 'child' &&
                wakeToApply.event.terminalClaimed === true;
            const toolClaimMustPersist = wakeToApply.trigger === 'tool' &&
                prepared.toolTerminalClaim?.won === true;
            const value = { prepared, wakeToApply };
            return (prepared.skipTurn && !toolClaimMustPersist) || terminalAlreadyClaimed
                ? { kind: 'noop', value }
                : { kind: 'write', snapshot: prepared.snapshot, value };
        },
    });

    const { prepared, wakeToApply } = reconciled.value;
    if (
        prepared.childTerminalClaim?.lateCompletion === true &&
        wakeToApply.trigger === 'child' &&
        wakeToApply.event.kind === 'child' &&
        wakeToApply.event.outcome !== 'failed'
    ) {
        defaultMetricsRegistry.increment('child.late_completion_total', {
            source: 'segment_wake',
        });
        try {
            await sessionManager.appendEvent(tenantId, taskId, 'task.child_late_completion', {
                token: wakeToApply.event.token,
                childTaskId: wakeToApply.event.childTaskId,
                completedAt: wakeToApply.event.completedAt ?? completedAt,
                resultPreview: makeSafeEventPreview(wakeToApply.event.output),
            });
        } catch (error) {
            log.warn('Failed to append late child completion diagnostic', {
                tenantId,
                taskId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (reconciled.status === 'committed') {
        const eventPayload = childTerminalEventPayload(
            prepared.childTerminalClaim ?? { snapshot: prepared.snapshot, won: false }
        );
        if (eventPayload !== undefined && typeof (sessionManager as any).appendEvent === 'function') {
            const eventType = prepared.childTerminalClaim?.kind === 'failed'
                ? 'task.child_failed'
                : 'task.child_completed';
            try {
                await sessionManager.appendEvent(tenantId, taskId, eventType, eventPayload);
            } catch (error) {
                log.warn('Terminal wake committed but diagnostic event append failed', {
                    tenantId,
                    taskId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            defaultMetricsRegistry.increment('child.terminal_race_winner_total', {
                kind: prepared.childTerminalClaim?.kind ?? 'unknown',
            });
            if (prepared.childTerminalClaim?.terminal?.error?.code === 'CHILD_TIMEOUT') {
                defaultMetricsRegistry.increment('child.timeout_total', {
                    source: wakeToApply.trigger === 'timer' ? 'timer' : 'completion',
                });
            }
        }
        if (prepared.toolTerminalClaim?.won === true && wakeToApply.trigger === 'tool') {
            const toolClaim = prepared.toolTerminalClaim;
            const eventType = toolClaim.terminal?.kind === 'detached'
                ? 'task.tool_detached'
                : 'task.tool_completed';
            try {
                await sessionManager.appendEvent(tenantId, taskId, eventType, {
                    token: wakeToApply.event.token,
                    toolName: toolClaim.entry?.name ?? toolClaim.terminal?.toolName,
                    ...(toolClaim.terminal?.reason !== undefined
                        ? { reason: toolClaim.terminal.reason }
                        : {}),
                    ...(eventType === 'task.tool_completed'
                        ? { resultPreview: makeSafeEventPreview((wakeToApply.event as { result?: unknown }).result) }
                        : {}),
                });
                if (toolClaim.terminal?.kind === 'detached') {
                    await sessionManager.appendEvent(tenantId, taskId, 'task.tool_late_completion', {
                        token: wakeToApply.event.token,
                        toolName: toolClaim.entry?.name ?? toolClaim.terminal?.toolName,
                        resultPreview: makeSafeEventPreview((wakeToApply.event as { result?: unknown }).result),
                    });
                }
            } catch (error) {
                log.warn('Tool terminal wake committed but diagnostic event append failed', {
                    tenantId,
                    taskId,
                    token: wakeToApply.event.token,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            defaultMetricsRegistry.increment('tool.terminal_winner_total', {
                kind: toolClaim.terminal?.kind ?? 'unknown',
            });
        }
    }
    if (
        reconciled.status === 'noop' &&
        prepared.toolTerminalClaim?.lateCompletion === true &&
        wakeToApply.trigger === 'tool'
    ) {
        defaultMetricsRegistry.increment('tool.late_completion_total', { source: 'segment_wake' });
        try {
            await sessionManager.appendEvent(tenantId, taskId, 'task.tool_late_completion', {
                token: wakeToApply.event.token,
                toolName: prepared.toolTerminalClaim.entry?.name ?? prepared.toolTerminalClaim.terminal?.toolName,
                resultPreview: makeSafeEventPreview((wakeToApply.event as { result?: unknown }).result),
            });
        } catch { /* diagnostic only */ }
    }
    return { ...prepared, wmVersion: reconciled.wmVersion };
}
