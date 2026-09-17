import { logger } from '@a2arium/callagent-utils';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { InboxManager, type EngineObservation } from './InboxManager.js';
import { makeSafeEventPreview } from './safeEventPreview.js';
import { reconcileSnapshotMutation, type SnapshotMutationSession } from './persistence/SnapshotRepository.js';
import { isTaskLifecycleTerminal, readTaskLifecycle } from './TaskLifecycle.js';
import { advanceTaskTurnGenerationInSnapshot } from './TaskTurnCoordinator.js';
import { addProcessedSegmentKey } from '../runtime/segmentProcessedKeys.js';
import { pickPlanStepStamp } from '../plans/planStepCorrelation.js';
import {
    getPendingTools,
    getPendingToolTerminals,
    setPendingTools,
    setPendingToolTerminals,
    type PendingTool,
    type PendingToolTerminal,
} from './ToolsRegistry.js';

const log = logger.createLogger({ prefix: 'ToolTerminalCoordinator' });

export type ToolTerminalDisposition =
    | 'committed_delivery'
    | 'committed_detached'
    | 'matching_replay'
    | 'competing_terminal'
    | 'missing';

export type ToolTerminalClaim = {
    snapshot: Record<string, unknown>;
    won: boolean;
    disposition: ToolTerminalDisposition;
    terminal?: PendingToolTerminal;
    entry?: PendingTool;
    observation?: EngineObservation;
    resumeEligible: boolean;
    lateCompletion: boolean;
    attempts?: number;
};

function toolObservationPredicate(token: string): (candidate: EngineObservation) => boolean {
    return (candidate) => candidate.kind === 'tool.completed' &&
        (candidate.payload as { token?: unknown } | undefined)?.token === token;
}

export function claimToolTerminalInSnapshot(
    base: Record<string, unknown>,
    params: {
        token: string;
        completedAt: string;
        result: unknown;
        taskId: string;
        detachReason?: string;
    }
): ToolTerminalClaim {
    const tools = getPendingTools(base);
    const entry = tools[params.token];
    const terminals = getPendingToolTerminals(base);
    const prior = terminals[params.token];
    if (prior !== undefined || entry === undefined) {
        const inbox = InboxManager.normalizeInbox((base as { inbox?: unknown }).inbox);
        const observation = inbox.all.find(toolObservationPredicate(params.token));
        const matchingReplay = prior?.kind === 'completed' && observation !== undefined;
        return {
            snapshot: base,
            won: false,
            disposition: prior === undefined
                ? 'missing'
                : matchingReplay
                  ? 'matching_replay'
                  : 'competing_terminal',
            terminal: prior,
            entry,
            ...(observation !== undefined ? { observation } : {}),
            resumeEligible: matchingReplay,
            lateCompletion: prior?.kind === 'detached',
        };
    }

    const lifecycle = readTaskLifecycle(base, params.taskId);
    const detached = params.detachReason !== undefined || isTaskLifecycleTerminal(lifecycle);
    const claimedAtMs = Date.parse(params.completedAt);
    const claimedAt = new Date(Number.isFinite(claimedAtMs) ? claimedAtMs : Date.now()).toISOString();
    const terminal: PendingToolTerminal = {
        kind: detached ? 'detached' : 'completed',
        claimedAt,
        toolName: entry.name,
        ownerTaskId: entry.ownerTaskId ?? params.taskId,
        rootTaskId: entry.rootTaskId ?? lifecycle?.rootTaskId ?? params.taskId,
        deliveryKey: entry.idempotencyKey ?? `${params.taskId}:tool:${params.token}`,
        ...pickPlanStepStamp(entry),
        ...(detached
            ? { reason: params.detachReason ?? `owner_${lifecycle?.state ?? 'terminal'}` }
            : {}),
    };

    delete tools[params.token];
    terminals[params.token] = terminal;
    let next = setPendingTools(base, tools);
    next = setPendingToolTerminals(next, terminals);
    const inbox = InboxManager.normalizeInbox((next as { inbox?: unknown }).inbox);
    inbox.current = inbox.current.filter((candidate) => !toolObservationPredicate(params.token)(candidate));
    inbox.all = inbox.all.filter((candidate) => !toolObservationPredicate(params.token)(candidate));

    let observation: EngineObservation | undefined;
    if (!detached) {
        observation = {
            source: 'tool',
            kind: 'tool.completed',
            payload: { token: params.token, result: params.result, tool: entry.name },
            provenance: {
                ts: Number.isFinite(claimedAtMs) ? claimedAtMs : Date.now(),
                turn: Number((base as { meta?: { turn?: number } }).meta?.turn ?? 0) + 1,
                id: params.token,
                toolId: entry.name,
                correlationId: params.token,
            },
        };
        next = { ...next, inbox: InboxManager.addObservationToInbox(inbox, observation) };
    } else {
        next = { ...next, inbox };
    }

    return {
        snapshot: next,
        won: true,
        disposition: detached ? 'committed_detached' : 'committed_delivery',
        terminal,
        entry,
        ...(observation !== undefined ? { observation } : {}),
        resumeEligible: !detached,
        lateCompletion: detached,
    };
}

export function detachPendingToolsInSnapshot(
    base: Record<string, unknown>,
    params: { taskId: string; reason: string; detachedAt: string }
): { snapshot: Record<string, unknown>; detached: Array<PendingToolTerminal & { token: string }> } {
    let next = base;
    const detached: Array<PendingToolTerminal & { token: string }> = [];
    for (const token of Object.keys(getPendingTools(next))) {
        const claim = claimToolTerminalInSnapshot(next, {
            token,
            completedAt: params.detachedAt,
            result: undefined,
            taskId: params.taskId,
            detachReason: params.reason,
        });
        next = claim.snapshot;
        if (claim.won && claim.terminal !== undefined) {
            detached.push({ ...claim.terminal, token });
        }
    }
    return { snapshot: next, detached };
}

export async function coordinateToolTerminal(params: {
    session: SnapshotMutationSession & {
        appendEvent?: (
            tenantId: string,
            sessionId: string,
            type: string,
            payload: Record<string, unknown>
        ) => Promise<unknown>;
    };
    tenantId: string;
    taskId: string;
    token: string;
    result: unknown;
    completedAt?: string;
    detachReason?: string;
    runtimeSurface?: 'direct' | 'in_process' | 'hatchet';
}): Promise<ToolTerminalClaim> {
    const completedAt = params.completedAt ?? new Date().toISOString();
    const result = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        operation: params.detachReason === undefined ? 'tool.terminal.complete' : 'tool.terminal.detach',
        mutate: ({ snapshot, storageNow }) => {
            const claim = claimToolTerminalInSnapshot(snapshot, {
                token: params.token,
                completedAt,
                result: params.result,
                taskId: params.taskId,
                detachReason: params.detachReason,
            });
            if (!claim.won) return { kind: 'noop' as const, value: claim };
            if (!claim.resumeEligible) {
                return { kind: 'write' as const, snapshot: claim.snapshot, value: claim };
            }
            const advanced = advanceTaskTurnGenerationInSnapshot({
                snapshot: claim.snapshot,
                tenantId: params.tenantId,
                taskId: params.taskId,
                runtimeSurface: params.runtimeSurface ?? 'in_process',
                storageNow,
            });
            const stagedSnapshot = addProcessedSegmentKey(
                advanced.snapshot,
                `${params.taskId}:tool:${params.token}`
            );
            const stagedClaim = { ...claim, snapshot: stagedSnapshot };
            return { kind: 'write' as const, snapshot: stagedClaim.snapshot, value: stagedClaim };
        },
    });
    const claim = { ...result.value, attempts: result.attempts };
    const eventType = claim.disposition === 'committed_delivery'
        ? 'task.tool_completed'
        : claim.disposition === 'committed_detached'
          ? 'task.tool_detached'
          : claim.lateCompletion
            ? 'task.tool_late_completion'
            : undefined;
    if (eventType !== undefined && params.session.appendEvent !== undefined) {
        try {
            await params.session.appendEvent(params.tenantId, params.taskId, eventType, {
                token: params.token,
                toolName: claim.entry?.name ?? claim.terminal?.toolName,
                ...(claim.terminal?.reason !== undefined ? { reason: claim.terminal.reason } : {}),
                ...(eventType === 'task.tool_completed'
                    ? { resultPreview: makeSafeEventPreview(params.result) }
                    : {}),
            });
            if (claim.disposition === 'committed_detached' && params.detachReason === undefined) {
                await params.session.appendEvent(params.tenantId, params.taskId, 'task.tool_late_completion', {
                    token: params.token,
                    toolName: claim.entry?.name ?? claim.terminal?.toolName,
                    completedAt,
                    resultPreview: makeSafeEventPreview(params.result),
                });
            }
        } catch (error) {
            log.warn('Tool terminal snapshot committed but diagnostic event append failed', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                token: params.token,
                eventType,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (result.status === 'committed') {
        defaultMetricsRegistry.increment('tool.terminal_winner_total', {
            kind: claim.terminal?.kind ?? 'unknown',
        });
    } else if (claim.lateCompletion) {
        defaultMetricsRegistry.increment('tool.late_completion_total', { source: 'terminal_coordinator' });
    }
    return claim;
}
