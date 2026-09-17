import { InboxManager, type EngineObservation } from './InboxManager.js';
import { getPendingGroups, getPendingTasks, setPendingGroups, setPendingTasks, type PendingTask, type PendingTaskTerminal } from './Handles.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';
import type { ChildEnvelope } from '../types/observation.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { makeSafeEventPreview } from './safeEventPreview.js';
import { logger } from '@a2arium/callagent-utils';
import { reconcileSnapshotMutation } from './persistence/SnapshotRepository.js';
import { advanceTaskTurnGenerationInSnapshot } from './TaskTurnCoordinator.js';
import { addProcessedSegmentKey } from '../runtime/segmentProcessedKeys.js';
import { pickPlanStepStamp } from '../plans/planStepCorrelation.js';

const log = logger.createLogger({ prefix: 'ChildTerminalCoordinator' });

export type ChildTerminalError = {
    code: string;
    message: string;
    timeoutMs?: number;
};

export type ChildTerminalDeliveryMode = 'inline' | 'async_wake';
export type ChildTerminalIdentity = {
    claimId: string;
    fence: string;
    generation: string;
    turnSeq: number;
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
          terminalIdentity?: ChildTerminalIdentity;
      }
    | {
          kind: 'failed';
          token: string;
          failedAt: string;
          childTaskId?: string;
          agentId?: string;
          error: ChildTerminalError;
          terminalIdentity?: ChildTerminalIdentity;
      };

export type ChildTerminalClaim = {
    snapshot: Record<string, unknown>;
    won: boolean;
    kind?: 'completed' | 'failed';
    observation?: EngineObservation;
    terminal?: PendingTaskTerminal;
    entry?: PendingTask;
    lateCompletion?: boolean;
    disposition?: 'committed' | 'matching_replay' | 'competing_terminal' | 'missing';
    deliveryMode?: ChildTerminalDeliveryMode;
    publicationDisposition?: 'new_delivery' | 'matching_replay' | 'inline_consumed' | 'none';
    attempts?: number;
    groupIntents?: Array<{
        kind: 'completed' | 'failed';
        groupToken: string;
        handler?: string;
        results: Record<string, unknown>;
    }>;
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
        const lateCompletion = request.kind === 'completed' && priorTerminal?.error?.code === 'CHILD_TIMEOUT';
        const requestedKind = request.kind;
        const sameFailure = requestedKind === 'failed' &&
            priorTerminal?.kind === 'failed' &&
            priorTerminal.error?.code === request.error.code;
        const matchingReplay = !lateCompletion && (
            (requestedKind === 'completed' && priorTerminal?.kind === 'completed') || sameFailure
        );
        const inbox = InboxManager.normalizeInbox((base as { inbox?: unknown }).inbox);
        const observation = inbox.all.find((candidate) =>
            (candidate.kind === 'child.completed' || candidate.kind === 'child.failed') &&
            (candidate.payload as { token?: unknown } | undefined)?.token === request.token &&
            (priorTerminal?.kind === 'completed'
                ? candidate.kind === 'child.completed'
                : candidate.kind === 'child.failed')
        );
        return {
            snapshot: base,
            won: false,
            terminal: priorTerminal,
            entry,
            ...(observation !== undefined ? { observation } : {}),
            lateCompletion,
            disposition: priorTerminal === undefined
                ? 'missing'
                : matchingReplay
                  ? 'matching_replay'
                  : 'competing_terminal',
            publicationDisposition: matchingReplay && observation !== undefined ? 'matching_replay' : 'none',
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
        deliveryKey: `${request.token}:terminal`,
        ...(childTaskId !== undefined ? { childTaskId } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(error !== undefined ? { error } : {}),
        ...pickPlanStepStamp(entry),
    };
    const identity = request.terminalIdentity;
    if (identity !== undefined) {
        terminal.claimId = identity.claimId;
        terminal.fence = identity.fence;
        terminal.generation = identity.generation;
        terminal.turnSeq = identity.turnSeq;
    }

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

    const groupIntents: NonNullable<ChildTerminalClaim['groupIntents']> = [];
    const groups = getPendingGroups(next);
    let groupsChanged = false;
    for (const [groupToken, rawGroup] of Object.entries(groups)) {
        if (!rawGroup.childTokens.includes(request.token) || rawGroup.results?.[request.token] !== undefined) {
            continue;
        }
        const group = {
            ...rawGroup,
            results: {
                ...(rawGroup.results ?? {}),
                [request.token]: kind === 'completed' && request.kind === 'completed'
                    ? { ok: true, value: request.result }
                    : { ok: false, error: error?.message ?? 'Child failed.' },
            },
        };
        groupsChanged = true;
        const allDone = group.childTokens.every((childToken) => group.results[childToken] !== undefined);
        if (kind === 'failed' && group.handlers?.anyFailed !== undefined) {
            groupIntents.push({
                kind: 'failed',
                groupToken,
                handler: group.handlers.anyFailed,
                results: group.results,
            });
            delete groups[groupToken];
        } else if (allDone) {
            groupIntents.push({
                kind: 'completed',
                groupToken,
                ...(group.handlers?.allCompleted !== undefined ? { handler: group.handlers.allCompleted } : {}),
                results: group.results,
            });
            delete groups[groupToken];
        } else {
            groups[groupToken] = group;
        }
    }
    if (groupsChanged) {
        next = setPendingGroups(next, groups);
    }

    return {
        snapshot: next,
        won: true,
        kind,
        observation,
        terminal,
        entry,
        lateCompletion: timedOut,
        disposition: 'committed',
        publicationDisposition: 'new_delivery',
        groupIntents,
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
    deliveryMode: ChildTerminalDeliveryMode;
    runtimeSurface?: 'direct' | 'in_process' | 'hatchet';
    maxAttempts?: number;
}): Promise<ChildTerminalClaim> {
    const result = await reconcileSnapshotMutation<ChildTerminalClaim>({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.parentTaskId,
        operation: 'child.terminal.claim',
        maxAttempts: params.maxAttempts,
        mutate: ({ snapshot, storageNow }) => {
            const claim = claimChildTerminalInSnapshot(snapshot, params.request);
            if (!claim.won) {
                return {
                    kind: 'noop' as const,
                    value: {
                        ...claim,
                        deliveryMode: params.deliveryMode,
                        publicationDisposition: claim.disposition === 'matching_replay'
                            ? params.deliveryMode === 'async_wake'
                                ? 'matching_replay' as const
                                : 'inline_consumed' as const
                            : 'none' as const,
                    } as ChildTerminalClaim,
                };
            }
            if (params.deliveryMode === 'inline') {
                const inlineClaim: ChildTerminalClaim = {
                    ...claim,
                    deliveryMode: params.deliveryMode,
                    publicationDisposition: 'inline_consumed' as const,
                };
                return { kind: 'write' as const, snapshot: inlineClaim.snapshot, value: inlineClaim };
            }
            const advanced = advanceTaskTurnGenerationInSnapshot({
                snapshot: claim.snapshot,
                tenantId: params.tenantId,
                taskId: params.parentTaskId,
                runtimeSurface: params.runtimeSurface ?? 'in_process',
                storageNow,
            });
            const stagedSnapshot = addProcessedSegmentKey(
                advanced.snapshot,
                `${params.parentTaskId}:child:${params.request.token}`
            );
            const stagedClaim: ChildTerminalClaim = {
                ...claim,
                snapshot: stagedSnapshot,
                deliveryMode: params.deliveryMode,
                publicationDisposition: 'new_delivery' as const,
            };
            return { kind: 'write' as const, snapshot: stagedClaim.snapshot, value: stagedClaim };
        },
    });
    const claim: ChildTerminalClaim = { ...result.value, attempts: result.attempts };

    defaultMetricsRegistry.increment('child.terminal_delivery_total', {
        mode: params.deliveryMode,
        disposition: claim.publicationDisposition ?? 'unknown',
    });
    if (claim.publicationDisposition === 'matching_replay' && params.deliveryMode === 'async_wake') {
        defaultMetricsRegistry.increment('child.deterministic_nudge_republication_total', {
            surface: params.runtimeSurface ?? 'in_process',
        });
    }

    if (result.status === 'committed') {
        const payload = childTerminalEventPayload(claim);
        if (payload !== undefined) {
            const eventPayload = claim.kind === 'completed' && params.request.kind === 'completed'
                ? { ...payload, resultPreview: makeSafeEventPreview(params.request.result) }
                : payload;
            try {
                await params.session.appendEvent(
                    params.tenantId,
                    params.parentTaskId,
                    claim.kind === 'failed' ? 'task.child_failed' : 'task.child_completed',
                    eventPayload
                );
            } catch (error) {
                log.warn('Terminal snapshot committed but diagnostic event append failed', {
                    tenantId: params.tenantId,
                    parentTaskId: params.parentTaskId,
                    token: params.request.token,
                    kind: claim.kind,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        defaultMetricsRegistry.increment('child.terminal_race_winner_total', {
            kind: claim.kind ?? 'unknown',
        });
        if (claim.terminal?.error?.code === 'CHILD_TIMEOUT') {
            defaultMetricsRegistry.increment('child.timeout_total', { source: params.request.kind });
        }
        for (const intent of claim.groupIntents ?? []) {
            try {
                await params.session.appendEvent(
                    params.tenantId,
                    params.parentTaskId,
                    intent.kind === 'failed' ? 'task.group_failed' : 'task.group_completed',
                    { groupToken: intent.groupToken }
                );
            } catch (error) {
                log.warn('Child terminal committed with group state but group event append failed', {
                    tenantId: params.tenantId,
                    parentTaskId: params.parentTaskId,
                    groupToken: intent.groupToken,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    } else if (claim.lateCompletion && params.request.kind === 'completed') {
        defaultMetricsRegistry.increment('child.late_completion_total', { source: 'terminal_coordinator' });
        try {
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
        } catch (error) {
            log.warn('Failed to append late child completion diagnostic', {
                tenantId: params.tenantId,
                parentTaskId: params.parentTaskId,
                token: params.request.token,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return claim;
}
