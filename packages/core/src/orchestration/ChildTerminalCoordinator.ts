import { InboxManager, type EngineObservation } from './InboxManager.js';
import { getPendingTasks, setPendingTasks, type PendingTask, type PendingTaskTerminal } from './Handles.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';
import type { ChildEnvelope } from '../types/observation.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { makeSafeEventPreview } from './safeEventPreview.js';

export type ChildTerminalError = {
    code: string;
    message: string;
    timeoutMs?: number;
};

export type ChildTerminalRequest =
    | {
          kind: 'completed';
          token: string;
          completedAt: string;
          childTaskId?: string;
          agentId?: string;
          result: unknown;
          executionMetadata?: ChildEnvelope['executionMetadata'];
      }
    | {
          kind: 'failed';
          token: string;
          failedAt: string;
          childTaskId?: string;
          agentId?: string;
          error: ChildTerminalError;
      };

export type ChildTerminalClaim = {
    snapshot: Record<string, unknown>;
    won: boolean;
    kind?: 'completed' | 'failed';
    observation?: EngineObservation;
    terminal?: PendingTaskTerminal;
    entry?: PendingTask;
    lateCompletion?: boolean;
};

function timeoutError(token: string, timeoutMs: number): ChildTerminalError {
    return {
        code: 'CHILD_TIMEOUT',
        message: `Child call timed out after ${timeoutMs}ms for token ${token}.`,
        timeoutMs,
    };
}

function terminalMap(snapshot: Record<string, unknown>): Record<string, PendingTaskTerminal> {
    return {
        ...(((snapshot as { pending?: { childTerminals?: Record<string, PendingTaskTerminal> } }).pending)
            ?.childTerminals ?? {}),
    };
}

export function getChildTerminal(
    snapshot: Record<string, unknown>,
    token: string
): PendingTaskTerminal | undefined {
    return terminalMap(snapshot)[token];
}

/**
 * Pure atomic-claim mutation. The caller persists the returned snapshot with CAS.
 * Re-running against the winning snapshot is a no-op, which makes timer and
 * completion workers safe to retry.
 */
export function claimChildTerminalInSnapshot(
    base: Record<string, unknown>,
    request: ChildTerminalRequest
): ChildTerminalClaim {
    const tasks = getPendingTasks(base);
    const entry = tasks[request.token];
    const priorTerminal = getChildTerminal(base, request.token) ?? entry?.terminal;
    if (entry === undefined || priorTerminal !== undefined) {
        return {
            snapshot: base,
            won: false,
            terminal: priorTerminal,
            entry,
            lateCompletion: request.kind === 'completed' && priorTerminal?.error?.code === 'CHILD_TIMEOUT',
        };
    }

    const requestedAt = Date.parse(request.kind === 'completed' ? request.completedAt : request.failedAt);
    const expiresAtMs = entry.expiresAt === undefined ? Number.NaN : Date.parse(entry.expiresAt);
    const timedOut = Number.isFinite(expiresAtMs) && requestedAt >= expiresAtMs;
    const kind: 'completed' | 'failed' = timedOut ? 'failed' : request.kind;
    const claimedAt = new Date(Number.isFinite(requestedAt) ? requestedAt : Date.now()).toISOString();
    const childTaskId = request.childTaskId ?? entry.childTaskId;
    const agentId = request.agentId ?? entry.agentId ?? entry.target;
    const error = timedOut
        ? timeoutError(request.token, entry.timeoutMs ?? Math.max(0, expiresAtMs - requestedAt))
        : request.kind === 'failed'
          ? request.error
          : undefined;
    const terminal: PendingTaskTerminal = {
        kind,
        claimedAt,
        ...(childTaskId !== undefined ? { childTaskId } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(error !== undefined ? { error } : {}),
    };

    const observation: EngineObservation = {
        source: 'child',
        kind: kind === 'completed' ? 'child.completed' : 'child.failed',
        payload: {
            token: request.token,
            ...(agentId !== undefined ? { agentId } : {}),
            ...(childTaskId !== undefined ? { childTaskId } : {}),
            ...(kind === 'completed' && request.kind === 'completed'
                ? {
                      result: request.result,
                      ...(request.executionMetadata !== undefined
                          ? { executionMetadata: request.executionMetadata }
                          : {}),
                  }
                : { error: error! }),
        },
        provenance: {
            ts: Number.isFinite(requestedAt) ? requestedAt : Date.now(),
            turn: Number((base as { meta?: { turn?: number } }).meta?.turn ?? 0) + 1,
            id: request.token,
            correlationId: request.token,
        },
    };

    const pending = { ...((base as { pending?: Record<string, unknown> }).pending ?? {}) };
    const children = { ...((pending.children as Record<string, unknown> | undefined) ?? {}) };
    delete children[request.token];
    pending.children = children;

    const autoClear = entry.options?.autoClearToken !== false;
    if (autoClear) {
        delete tasks[request.token];
    } else {
        tasks[request.token] = { ...entry, terminal };
    }
    const terminals = terminalMap(base);
    terminals[request.token] = terminal;
    pending.childTerminals = terminals;

    let next = setPendingTasks({ ...base, pending }, tasks);
    if (entry.options?.setToken !== false && autoClear) {
        next = TaskStateUtils.removeControlVarFromSnapshot(
            next,
            entry.options?.tokenPath ?? 'child.token'
        );
    }
    const terminalPredicate = (candidate: EngineObservation) =>
        (candidate.kind === 'child.completed' || candidate.kind === 'child.failed') &&
        (candidate.payload as { token?: unknown } | undefined)?.token === request.token;
    const inbox = InboxManager.normalizeInbox((next as { inbox?: unknown }).inbox);
    // The durable claim is authoritative. Remove any terminal observation that
    // predates the claim (possible in snapshots written by older runtimes), then
    // stage exactly the winning completion/failure envelope.
    inbox.current = inbox.current.filter((candidate) => !terminalPredicate(candidate));
    inbox.all = inbox.all.filter((candidate) => !terminalPredicate(candidate));
    next = {
        ...next,
        inbox: InboxManager.addObservationToInbox(inbox, observation),
    };

    return {
        snapshot: next,
        won: true,
        kind,
        observation,
        terminal,
        entry,
        lateCompletion: timedOut,
    };
}

export function childTerminalEventPayload(claim: ChildTerminalClaim): Record<string, unknown> | undefined {
    if (!claim.won || claim.observation === undefined) return undefined;
    return claim.observation.payload as Record<string, unknown>;
}

export type ChildTerminalSession = {
    load: (tenantId: string, sessionId: string) => Promise<{
        snapshot?: unknown;
        wmVersion?: bigint;
        agentId?: string;
    } | null>;
    saveSnapshot: (params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }) => Promise<unknown>;
    appendEvent: (
        tenantId: string,
        sessionId: string,
        type: string,
        payload: Record<string, unknown>
    ) => Promise<unknown>;
};

/** Shared CAS coordinator used by core and durable drivers. */
export async function coordinateChildTerminal(params: {
    session: ChildTerminalSession;
    tenantId: string;
    parentTaskId: string;
    request: ChildTerminalRequest;
    maxAttempts?: number;
}): Promise<ChildTerminalClaim> {
    const maxAttempts = params.maxAttempts ?? 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const row = await params.session.load(params.tenantId, params.parentTaskId);
        if (row === null) {
            return { snapshot: {}, won: false };
        }
        const base = (row.snapshot as Record<string, unknown> | undefined) ?? {};
        const claim = claimChildTerminalInSnapshot(base, params.request);
        if (!claim.won) {
            if (claim.lateCompletion && params.request.kind === 'completed') {
                defaultMetricsRegistry.increment('child.late_completion_total', { source: 'terminal_coordinator' });
                await params.session.appendEvent(
                    params.tenantId,
                    params.parentTaskId,
                    'task.child_late_completion',
                    {
                        token: params.request.token,
                        childTaskId: params.request.childTaskId ?? claim.terminal?.childTaskId,
                        agentId: params.request.agentId ?? claim.terminal?.agentId,
                        completedAt: params.request.completedAt,
                        resultPreview: makeSafeEventPreview(params.request.result),
                    }
                );
            }
            return claim;
        }
        try {
            await params.session.saveSnapshot({
                tenantId: params.tenantId,
                sessionId: params.parentTaskId,
                agentId:
                    row.agentId ??
                    (base as { meta?: { agentId?: string } }).meta?.agentId ??
                    'default',
                expectedWmVersion: row.wmVersion ?? BigInt(0),
                snapshot: claim.snapshot,
            });
            const payload = childTerminalEventPayload(claim);
            if (payload !== undefined) {
                await params.session.appendEvent(
                    params.tenantId,
                    params.parentTaskId,
                    claim.kind === 'failed' ? 'task.child_failed' : 'task.child_completed',
                    payload
                );
            }
            defaultMetricsRegistry.increment('child.terminal_race_winner_total', {
                kind: claim.kind ?? 'unknown',
            });
            if (claim.terminal?.error?.code === 'CHILD_TIMEOUT') {
                defaultMetricsRegistry.increment('child.timeout_total', { source: params.request.kind });
            }
            return claim;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if ((message === 'CAS_MISMATCH' || message === 'WM_VERSION_CONFLICT') && attempt < maxAttempts) {
                continue;
            }
            throw error;
        }
    }
    throw new Error('CAS_MISMATCH');
}
