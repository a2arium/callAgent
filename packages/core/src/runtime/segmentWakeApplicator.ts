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
import { getPendingTasks, setPendingTasks } from '../orchestration/Handles.js';
import type { TurnExecutionParams, TurnTrigger as TurnRunnerTrigger } from '../orchestration/TurnRunner.js';
import type { ConversationPayload } from '../types/observation.js';
import type { TurnWake } from './turnExecutor.js';

export type PreparedSegmentWake = {
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    agentId: string;
    trigger: TurnRunnerTrigger;
    /** Extra fields passed through to TurnRunner.runTurn (beyond tenant/session/trigger). */
    turnParams: Partial<TurnExecutionParams>;
    /** Token expiry surfaced for await_input boundary mapping. */
    inputExpiresAt?: string;
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
    opts?: { agentId?: string }
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
            const { next } = applyInputProvided(base, wake.event.token, wake.event.value);
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
            const tasks = getPendingTasks(base);
            const pendingTask = tasks[event.token];
            const options = pendingTask?.options ?? {};
            const shouldSetToken = options.setToken !== false;
            const shouldAutoClear = options.autoClearToken !== false;
            const childTokenPath = options.tokenPath ?? 'child.token';
            const clean = TaskStateUtils.extractCleanChildResult(event.output);
            const observation: EngineObservation = {
                source: 'child',
                kind: 'child.completed',
                payload: {
                    token: event.token,
                    childTaskId: clean.childTaskId ?? event.childTaskId,
                    result: clean.result,
                    executionMetadata: clean.executionMetadata,
                },
                provenance: observationProvenance(event.token, turnFromSnapshot(base)),
            };
            let next: Record<string, unknown> = {
                ...base,
                inbox: InboxManager.addObservationToInbox((base as { inbox?: unknown }).inbox, observation),
            };
            if (pendingTask !== undefined && shouldAutoClear) {
                delete tasks[event.token];
                next = setPendingTasks(next, tasks);
            }
            if (shouldSetToken && shouldAutoClear) {
                next = TaskStateUtils.removeControlVarFromSnapshot(next, childTokenPath);
            }
            return {
                snapshot: next,
                wmVersion: BigInt(0),
                agentId: agentIdFromSnapshot(next, opts?.agentId),
                // Inbox already carries child.completed; resume matches TaskEngine child path.
                trigger: 'resume',
                turnParams: {},
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
            const next = {
                ...base,
                inbox: InboxManager.addObservationToInbox((base as { inbox?: unknown }).inbox, observation),
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
        const prepared = applyWakeToSnapshot(base, wake, { agentId });
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

    const snap = await sessionManager.load(tenantId, taskId);
    if (snap === null || snap === undefined) {
        throw new Error(`Session not found for ${taskId}`);
    }
    const base = (snap.snapshot as Record<string, unknown>) || {};
    const prepared = applyWakeToSnapshot(base, wake, { agentId });

    const saveResult = await sessionManager.saveSnapshot({
        tenantId,
        sessionId: taskId,
        agentId: prepared.agentId,
        expectedWmVersion: snap.wmVersion ?? BigInt(0),
        snapshot: prepared.snapshot,
    });
    if (saveResult === null) {
        throw new Error('CAS_MISMATCH');
    }

    return { ...prepared, wmVersion: snap.wmVersion ?? BigInt(0) };
}
