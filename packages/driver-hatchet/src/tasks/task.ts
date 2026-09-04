import type {
    DurableTaskTerminal,
    RuntimeResultCachePolicy,
    RuntimeWakeEvent,
    RuntimeTimerRecord,
    RuntimeTimerRepository,
} from '@a2arium/callagent-core/unstable';
import {
    claimTaskTerminalInSnapshot,
    coordinateChildTerminal,
    defaultMetricsRegistry,
    prepareChildResultForPersistence,
    readDurableTaskTerminal,
    readSegmentCancellation,
    reconcileSnapshotMutation,
    settleUnclaimedTaskTurnInSnapshot,
    timerKindToReason,
} from '@a2arium/callagent-core/unstable';
import type { SessionManager } from '@a2arium/callagent-core/unstable';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { Prisma } from '@a2arium/callagent-memory-sql/generated';
import type { DurableContext } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { Duration } from '@hatchet-dev/typescript-sdk/v1/client/duration.js';
import type { JsonObject, JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import { Or, SleepCondition, UserEventCondition } from '@hatchet-dev/typescript-sdk/v1/conditions/index.js';
import type { HatchetClient } from '../hatchetClient.js';
import {
    SEGMENT_TASK_NAME,
    type SegmentTaskBoundary,
    type SegmentTaskInput,
    type SegmentTaskOutput,
    type SegmentTaskWake,
} from './segment.js';
import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk/v1/task.js';
import type {
    OutboxDispatchInput,
    OutboxDispatchOutput,
} from './outboxDispatch.js';
import { OUTBOX_DISPATCH_TASK_NAME } from './outboxDispatch.js';
import { serializeDriverRunError, type DriverRunsRepository } from '../driverRunsRepository.js';
import { withHatchetTaskLogging } from '../hatchetLogging.js';
import { logger } from '@a2arium/callagent-utils';
import { convergeProviderTerminal } from '../providerTerminalReconciler.js';

export const TASK_TASK_NAME = 'aplret.task';
export const TASK_STATE_TASK_NAME = 'aplret.task-state';

export type TaskProtocolNames = {
    task: string;
    segment: string;
    taskState: string;
};

export const DEFAULT_TASK_PROTOCOL_NAMES: TaskProtocolNames = Object.freeze({
    task: TASK_TASK_NAME,
    segment: SEGMENT_TASK_NAME,
    taskState: TASK_STATE_TASK_NAME,
});

export function createNamespacedTaskProtocolNames(namespace: string): TaskProtocolNames {
    const normalized = namespace.trim().replace(/\.+$/u, '');
    if (normalized.length === 0) {
        throw new Error('HATCHET_TASK_PROTOCOL_NAMESPACE_REQUIRED');
    }
    return {
        task: `${normalized}.task`,
        segment: `${normalized}.segment`,
        taskState: `${normalized}.task-state`,
    };
}
const BOUNDARY_EVENT_LOOKBACK = '5m';
const TASK_EXECUTION_TIMEOUT = '30m';
const DEFAULT_AWAIT_CHILD_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_AWAIT_CHILD_MAX_WAIT_MS = 25 * 60_000;
const log = logger.createLogger({ prefix: 'HatchetTask' });

export type TaskTaskInput = JsonObject & {
    tenantId: string;
    taskId: string;
    agentId?: string;
    input: JsonValue;
    cache?: RuntimeResultCachePolicy;
    idempotencyKey: string;
    rootTaskId?: string;
    parentTaskId?: string;
    tenantTaskKey?: string;
    rootRunKey?: string;
    recoveryGeneration?: string;
    recoveryDeliveryKey?: string;
};

export type TaskTaskOutput = SegmentTaskOutput;

type TaskResultCache = Pick<AgentResultCache, 'getCachedResult' | 'setCachedResult'>;

export type TaskTaskDeps = {
    /** Production roots route state/projection work through aplret.task-state. */
    useTaskStateChildren?: boolean;
    /** Coherent workflow names used by a root and its children. Defaults preserve production history. */
    protocolNames?: TaskProtocolNames;
    driverRuns?: DriverRunsRepository;
    runtimeTimers?: RuntimeTimerRepository;
    agentResultCache?: TaskResultCache;
    resolveCacheConfig?: (agentId: string | undefined) => RuntimeResultCachePolicy | undefined;
    sessionManager?: {
        load: (
            tenantId: string,
            sessionId: string
        ) => Promise<{ snapshot?: unknown; wmVersion?: bigint; agentId?: string } | null>;
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
    events?: {
        push: (
            eventKey: string,
            payload: Record<string, unknown>,
            options?: { key?: string }
        ) => Promise<unknown>;
    };
    prisma?: {
        wMSession?: {
            findUnique: (args: {
                where: {
                    tenantId_sessionId: {
                        tenantId: string;
                        sessionId: string;
                    };
                };
                select: { snapshot: true };
            }) => Promise<{ snapshot: JsonValue } | null>;
        };
        outbox: {
            findMany: (args: {
                where: {
                    tenantId: string;
                    key: string;
                    topic: { in: string[] };
                };
                orderBy: { createdAt: 'asc' };
                take: number;
            }) => Promise<Array<{
                id: string;
                tenantId: string;
                topic: string;
                key: string;
                payload: JsonValue;
                createdAt: Date;
            }>>;
        };
        wMEvent?: {
            findMany: (args: {
                where: {
                    tenantId: string;
                    sessionId: string;
                    type: { in: string[] };
                };
                orderBy: { seq: 'desc' };
                take: number;
            }) => Promise<Array<{
                eventId: string;
                tenantId: string;
                sessionId: string;
                seq: number;
                type: string;
                payload: JsonValue;
                createdAt: Date;
            }>>;
        };
    };
};

type TaskStateOperation =
    | 'bootstrap'
    | 'reload_authoritative'
    | 'find_boundary_event'
    | 'find_child_task_id'
    | 'list_outbox'
    | 'inspect_cancellation'
    | 'schedule_timer'
    | 'mark_timer_fired'
    | 'cancel_timers'
    | 'project_terminal'
    | 'project_failed'
    | 'project_canceled';

export type TaskStateInput = JsonObject & {
    operation: TaskStateOperation;
    task: TaskTaskInput;
    boundary?: SegmentTaskBoundary;
    segment?: SegmentTaskOutput;
    error?: JsonValue;
    timerKind?: 'token_expiry' | 'sleep' | 'child_timeout';
    timerId?: string;
    token?: string;
};

export type TaskStateOutput = JsonObject & {
    persistedBoundary?: { boundary: AwaitableBoundary; turnSeq: number };
    cachedSegment?: SegmentTaskOutput;
    terminalSegment?: SegmentTaskOutput;
    event?: RuntimeWakeEvent & { idempotencyKey?: string };
    authoritativeBoundary?: SegmentTaskBoundary;
    childTaskId?: string;
    outboxChildren?: OutboxDispatchInput[];
    operatorCanceled?: boolean;
    timer?: {
        timerId: string;
        dueAt: string;
        kind: string;
        idempotencyKey: string;
        payload?: JsonValue;
    };
    firedAt?: string;
};

type TaskStateChildOutput =
    | TaskStateOutput
    | (JsonObject & { [TASK_STATE_TASK_NAME]: TaskStateOutput });

type AwaitableBoundary = Extract<
    SegmentTaskBoundary,
    { kind: 'await_input' | 'await_tool' | 'await_child' | 'await_event' }
>;
type SegmentEventWake = Exclude<SegmentTaskWake, { trigger: 'start' }>;
type TimerBoundary = Extract<SegmentTaskBoundary, { kind: 'await_input' | 'await_child' | 'sleep' }>;

export async function executeTaskTask(
    input: TaskTaskInput,
    ctx: DurableContext<TaskTaskInput>,
    deps?: TaskTaskDeps
): Promise<TaskTaskOutput> {
    return withHatchetTaskLogging(input, ctx, 'agent.run', () =>
        executeTaskTaskInner(input, ctx, deps)
    );
}

async function executeTaskTaskInner(
    input: TaskTaskInput,
    ctx: DurableContext<TaskTaskInput>,
    deps?: TaskTaskDeps
): Promise<TaskTaskOutput> {
    const protocolNames = deps?.protocolNames ?? DEFAULT_TASK_PROTOCOL_NAMES;
    let wake: SegmentTaskWake = { trigger: 'start', input: input.input };
    let idempotencyKey = input.idempotencyKey;
    let turnSeq = 0;
    let recoveryGeneration = input.recoveryGeneration;

    try {
        const bootstrap = await runTaskState(ctx, input, deps, {
            operation: 'bootstrap',
            task: input,
        }, `bootstrap:${idempotencyKey}`);
        const persistedBoundary = bootstrap !== undefined
            ? bootstrap.persistedBoundary
            : await findPersistedAwaitBoundary(input, deps);
        if (persistedBoundary !== undefined) {
            const event =
                await findPersistedBoundaryEventRecorded(
                    ctx, input, persistedBoundary.boundary, deps,
                    `bootstrap:${persistedBoundary.turnSeq}:${persistedBoundary.boundary.token}`
                )
                ?? await waitForBoundaryEvent(ctx, input, persistedBoundary.boundary, deps);
            const hydratedEvent = await hydratePersistedBoundaryEventRecorded(
                ctx, input, persistedBoundary.boundary, event, deps,
                `bootstrap-hydrate:${persistedBoundary.turnSeq}:${persistedBoundary.boundary.token}:${event.idempotencyKey ?? event.kind}`
            );
            wake = boundaryEventToWake(persistedBoundary.boundary, hydratedEvent);
            idempotencyKey = hydratedEvent.idempotencyKey ?? `${input.taskId}:${hydratedEvent.kind}:${hydratedEvent.token}`;
            turnSeq = persistedBoundary.turnSeq;
        }

        if (persistedBoundary === undefined) {
            const cachedSegment = bootstrap !== undefined
                ? bootstrap.cachedSegment
                : await resolveCachedStartSegment(input, deps);
            if (cachedSegment !== undefined) {
                const projection = await runTaskState(ctx, input, deps, {
                    operation: 'project_terminal', task: input, segment: cachedSegment,
                }, `terminal:cache:${idempotencyKey}`);
                if (projection === undefined) {
                    return projectTerminalSegment(input, cachedSegment, deps);
                }
                return projection.terminalSegment ?? cachedSegment;
            }
        }

        for (;;) {
            turnSeq += 1;
            const segmentInput: SegmentTaskInput = {
                tenantId: input.tenantId,
                taskId: input.taskId,
                agentId: input.agentId,
                wake,
                idempotencyKey,
                attemptSeq: turnSeq,
                rootTaskId: input.rootTaskId ?? input.taskId,
                ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
                ...(input.rootRunKey !== undefined ? { rootRunKey: input.rootRunKey } : {}),
                ...(recoveryGeneration !== undefined
                    ? { recoveryGeneration }
                    : {}),
            };
            const segmentRaw = await ctx.runChild<SegmentTaskInput, SegmentTaskOutput>(
                protocolNames.segment,
                segmentInput,
                {
                    key: `${input.rootRunKey ?? input.taskId}:segment:${turnSeq}:${idempotencyKey}`,
                    additionalMetadata: buildTaskRunMetadata(input, segmentInput),
                }
            );
            const segment = normalizeSegmentOutput(segmentRaw, protocolNames.segment);
            await dispatchPendingOutboxChildren(ctx, input, segment, deps);

            if (segment.turnDisposition === 'queued') {
                await waitForTurnAvailability(ctx, input, turnSeq);
                continue;
            }
            if (segment.turnDisposition === 'lease_expired_recovery_staged') {
                if (segment.claimedGeneration === undefined) {
                    throw new Error('TASK_TURN_PROTOCOL_STATE_UNKNOWN: lease recovery omitted claimedGeneration');
                }
                recoveryGeneration = segment.claimedGeneration;
                idempotencyKey = `${input.taskId}:turn-request:${segment.claimedGeneration}`;
                await waitForTurnAvailability(ctx, input, turnSeq);
                continue;
            }
            recoveryGeneration = undefined;

            let boundary = segment.boundary;
            if (deps?.useTaskStateChildren === true && segment.turnDisposition !== 'executed') {
                const authoritative = await runTaskState(ctx, input, deps, {
                    operation: 'reload_authoritative', task: input,
                }, `authoritative:${turnSeq}:${segment.turnDisposition ?? 'unknown'}`);
                if (authoritative?.authoritativeBoundary === undefined) {
                    defaultMetricsRegistry.increment('hatchet_root_transition_total', {
                        disposition: segment.turnDisposition ?? 'unknown',
                        status: 'recovering',
                    });
                    await waitForTurnAvailability(ctx, input, turnSeq);
                    continue;
                }
                boundary = authoritative.authoritativeBoundary;
            }

            if (isTerminalBoundary(boundary)) {
                const authoritativeSegment = boundary === segment.boundary
                    ? segment
                    : { ...segment, boundary };
                if (!await runTaskState(ctx, input, deps, {
                    operation: 'project_terminal', task: input, segment: authoritativeSegment,
                }, `terminal:${turnSeq}:${idempotencyKey}`)) {
                    await projectTerminalSegment(input, authoritativeSegment, deps);
                }
                return authoritativeSegment;
            }

            if (
                boundary.kind === 'await_input' ||
                boundary.kind === 'await_tool' ||
                boundary.kind === 'await_child' ||
                boundary.kind === 'await_event'
            ) {
                const event =
                    await findPersistedBoundaryEventRecorded(
                        ctx, input, boundary, deps,
                        `turn:${turnSeq}:${boundary.token}`
                    )
                    ?? await waitForBoundaryEvent(ctx, input, boundary, deps);
                const hydratedEvent = await hydratePersistedBoundaryEventRecorded(
                    ctx, input, boundary, event, deps,
                    `turn-hydrate:${turnSeq}:${boundary.token}:${event.idempotencyKey ?? event.kind}`
                );
                wake = boundaryEventToWake(boundary, hydratedEvent);
                idempotencyKey = hydratedEvent.idempotencyKey ?? `${input.taskId}:${hydratedEvent.kind}:${hydratedEvent.token}`;
                continue;
            }

            if (boundary.kind === 'sleep') {
                const event = await waitForSleepBoundary(ctx, input, boundary, deps);
                wake = { trigger: 'timer', event: event as SegmentEventWake['event'] };
                idempotencyKey = event.idempotencyKey ?? `${input.taskId}:timer:${event.token}`;
                continue;
            }

            return segment;
        }
    } catch (error) {
        if (await isOperatorCancellationAbortRecorded(ctx, input, deps, error, idempotencyKey)) {
            if (!await runTaskState(ctx, input, deps, {
                operation: 'project_canceled', task: input,
            }, `canceled:${idempotencyKey}`)) await finalizeRootRunAsCanceled(input, deps);
        } else if (!isHatchetDurableEvictionAbort(error)) {
            try {
                if (!await runTaskState(ctx, input, deps, {
                    operation: 'project_failed', task: input,
                    error: serializeDriverRunError(error) as JsonValue,
                }, `failed:${idempotencyKey}`)) {
                    await finalizeRootRunAsFailed(input, deps, error);
                    await convergeFailedProviderTerminal(input, deps, error);
                }
            } catch (projectionError) {
                // A broken durable stream can prevent task.state from running.
                // Preserve the original provider failure in the durable driver
                // ledger so the independent reconciler can converge it later.
                await finalizeRootRunAsFailed(input, deps, error).catch(() => undefined);
                await convergeFailedProviderTerminal(input, deps, error).catch(() => undefined);
                console.error('HATCHET_TERMINAL_PROJECTION_FAILED', {
                    taskId: input.taskId,
                    message: projectionError instanceof Error ? projectionError.message : String(projectionError),
                });
            }
        }
        throw error;
    }
}

async function runTaskState(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    deps: TaskTaskDeps | undefined,
    stateInput: TaskStateInput,
    key: string
): Promise<TaskStateOutput | undefined> {
    if (deps?.useTaskStateChildren !== true) return undefined;
    const taskStateName = deps.protocolNames?.taskState ?? TASK_STATE_TASK_NAME;
    const output = await ctx.runChild<TaskStateInput, TaskStateChildOutput>(taskStateName, stateInput, {
        key: `${input.rootRunKey ?? input.taskId}:state:${key}`,
        additionalMetadata: {
            operation: `task.state.${stateInput.operation}`,
            tenantId: input.tenantId,
            taskId: input.taskId,
        },
    });
    return normalizeTaskStateOutput(output, taskStateName);
}

export async function executeTaskStateTask(
    input: TaskStateInput,
    deps: TaskTaskDeps
): Promise<TaskStateOutput> {
    const task = input.task;
    switch (input.operation) {
        case 'bootstrap': {
            const persistedBoundary = await findPersistedAwaitBoundary(task, deps);
            const cachedSegment = persistedBoundary === undefined
                ? await resolveCachedStartSegment(task, deps)
                : undefined;
            return {
                ...(persistedBoundary !== undefined ? { persistedBoundary } : {}),
                ...(cachedSegment !== undefined ? { cachedSegment } : {}),
            } as TaskStateOutput;
        }
        case 'reload_authoritative': {
            const loaded = await deps.sessionManager?.load(task.tenantId, task.taskId);
            const terminal = readDurableTaskTerminal(loaded?.snapshot);
            if (terminal !== undefined) {
                const boundary: SegmentTaskBoundary = terminal.state === 'completed'
                    ? { kind: 'complete', result: terminal.status.metadata?.result as JsonValue }
                    : terminal.state === 'canceled'
                      ? { kind: 'canceled', reason: terminal.status.metadata?.reason as string | undefined }
                      : { kind: 'fail', error: (terminal.status.metadata ?? terminal.status.message) as JsonValue };
                return { authoritativeBoundary: boundary };
            }
            const persisted = await findPersistedAwaitBoundary(task, deps);
            return persisted === undefined ? {} : { authoritativeBoundary: persisted.boundary };
        }
        case 'find_boundary_event': {
            if (input.boundary === undefined || !isAwaitableBoundary(input.boundary)) return {};
            const event = await findPersistedBoundaryEvent(task, input.boundary, deps);
            const hydrated = event === undefined
                ? undefined
                : await hydratePersistedBoundaryEvent(task, input.boundary, event, deps);
            return hydrated === undefined ? {} : { event: hydrated } as TaskStateOutput;
        }
        case 'find_child_task_id': {
            if (input.boundary?.kind !== 'await_child') return {};
            const childTaskId = await findPersistedChildTaskId(task, input.boundary, deps);
            return childTaskId === undefined ? {} : { childTaskId };
        }
        case 'list_outbox':
            return { outboxChildren: await listPendingOutboxChildren(task, input.segment, deps) };
        case 'inspect_cancellation': {
            if (deps.prisma?.wMSession === undefined) return { operatorCanceled: false };
            const row = await deps.prisma.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId: task.tenantId, sessionId: task.taskId } },
                select: { snapshot: true },
            });
            return { operatorCanceled: readSegmentCancellation(row?.snapshot) !== undefined };
        }
        case 'schedule_timer': {
            if (input.boundary === undefined || input.timerKind === undefined || deps.runtimeTimers === undefined) {
                throw new Error('task-state schedule_timer requires a boundary, kind, and timer repository');
            }
            const timer = await scheduleBoundaryTimer(task, input.boundary as TimerBoundary, deps.runtimeTimers, input.timerKind);
            return {
                timer: {
                    timerId: timer.timerId,
                    dueAt: timer.dueAt.toISOString(),
                    kind: timer.kind,
                    idempotencyKey: timer.idempotencyKey,
                    ...(timer.payload !== undefined && timer.payload !== null
                        ? { payload: timer.payload as JsonValue }
                        : {}),
                },
            };
        }
        case 'mark_timer_fired': {
            if (input.token === undefined || input.timerId === undefined || deps.runtimeTimers === undefined) {
                throw new Error('task-state mark_timer_fired requires token, timerId, and timer repository');
            }
            const firedAt = new Date().toISOString();
            await deps.runtimeTimers.markFiredByTimerId({
                tenantId: task.tenantId, taskId: task.taskId, token: input.token,
                timerId: input.timerId, firedAt: new Date(firedAt),
            });
            return { firedAt };
        }
        case 'cancel_timers':
            await deps.runtimeTimers?.cancelTaskTimers({
                tenantId: task.tenantId, taskId: task.taskId,
                ...(input.token !== undefined ? { token: input.token } : {}),
            });
            return {};
        case 'project_terminal': {
            if (input.segment === undefined) throw new Error('task-state project_terminal requires segment');
            const terminalSegment = await projectTerminalSegment(task, input.segment, deps);
            return isCacheOriginSegment(input.segment) ? { terminalSegment } : {};
        }
        case 'project_failed':
            await finalizeRootRunAsFailed(task, deps, input.error);
            await convergeFailedProviderTerminal(task, deps, input.error);
            return {};
        case 'project_canceled':
            await finalizeRootRunAsCanceled(task, deps);
            return {};
    }
}

function isAwaitableBoundary(boundary: SegmentTaskBoundary): boundary is AwaitableBoundary {
    return boundary.kind === 'await_input' || boundary.kind === 'await_tool' ||
        boundary.kind === 'await_child' || boundary.kind === 'await_event';
}

async function waitForTurnAvailability(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    attemptOrdinal: number
): Promise<void> {
    if (typeof ctx.waitFor !== 'function') {
        await ctx.sleepFor('1s', `turn-owner:${attemptOrdinal}`);
        return;
    }
    const tenantTaskKey = input.tenantTaskKey ?? encodeTenantTaskKey(input.tenantId, input.taskId);
    await ctx.waitFor(
        Or(
            new UserEventCondition(`task-turn-available:${tenantTaskKey}`, '', 'available'),
            new SleepCondition('5s', 'recovery')
        ),
        `turn-owner:${attemptOrdinal}`
    );
}

function encodeTenantTaskKey(tenantId: string, taskId: string): string {
    return `${tenantId.length}:${tenantId}:${taskId.length}:${taskId}`;
}

async function resolveCachedStartSegment(
    input: TaskTaskInput,
    deps?: TaskTaskDeps
): Promise<SegmentTaskOutput | undefined> {
    const cacheConfig = resolveEffectiveCacheConfig(input, deps);
    if (!cacheConfig.enabled || input.agentId === undefined) {
        return undefined;
    }
    const cache = resolveResultCache(input, deps);
    if (cache === undefined) {
        return undefined;
    }

    let cachedResult: unknown;
    try {
        cachedResult = await cache.getCachedResult(
            input.agentId,
            input.input as never,
            cacheConfig.excludePaths ?? [],
            input.tenantId
        );
    } catch (error) {
        log.warn('Failed to read durable task result cache', {
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
    const normalized = normalizeDurableCacheableResult(cachedResult);
    if (cachedResult == null || !normalized.cacheable) {
        return undefined;
    }

    return {
        tenantId: input.tenantId,
        taskId: input.taskId,
        agentId: input.agentId,
        boundary: { kind: 'complete', result: normalized.result as JsonValue },
        taskStatus: {
            state: 'completed',
            timestamp: new Date().toISOString(),
            metadata: { source: 'cache', origin: 'cache' },
        } as never,
        executionMetadata: { origin: 'cache' },
    } as TaskTaskOutput;
}

function isCacheOriginSegment(segment: SegmentTaskOutput): boolean {
    return segment.executionMetadata?.origin === 'cache';
}

async function prepareCachedTerminalSegment(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<SegmentTaskOutput> {
    if (segment.boundary.kind !== 'complete') return segment;
    const preparedResult = await prepareChildResultForPersistence(
        segment.boundary.result,
        resolveResultCache(input, deps) as AgentResultCache | undefined,
        input.tenantId
    );
    return {
        ...segment,
        boundary: { kind: 'complete', result: preparedResult as JsonValue },
    };
}

function statusForTerminalBoundary(
    segment: SegmentTaskOutput,
    timestamp: string
): DurableTaskTerminal['status'] {
    const boundary = segment.boundary;
    if (boundary.kind !== 'complete' && boundary.kind !== 'canceled' && boundary.kind !== 'fail') {
        throw new Error(`Cannot persist non-terminal cache boundary: ${boundary.kind}`);
    }
    const state: DurableTaskTerminal['state'] = boundary.kind === 'complete'
        ? 'completed'
        : boundary.kind === 'canceled'
          ? 'canceled'
          : 'failed';
    const rawStatus = isRecord(segment.taskStatus) ? segment.taskStatus : undefined;
    const matchingRawStatus = rawStatus?.state === state ? rawStatus : undefined;
    const rawMetadata = isRecord(matchingRawStatus?.metadata)
        ? matchingRawStatus.metadata
        : {};
    const metadata: Record<string, unknown> = {
        ...rawMetadata,
        ...(boundary.kind === 'complete'
            ? { result: boundary.result }
            : boundary.kind === 'canceled'
              ? { reason: boundary.reason }
              : { error: boundary.error }),
        ...(isCacheOriginSegment(segment) ? { source: 'cache', origin: 'cache' } : {}),
    };
    const message = matchingRawStatus?.message;
    return {
        state,
        timestamp,
        ...(isRecord(message)
            ? { message: message as DurableTaskTerminal['status']['message'] }
            : {}),
        metadata,
    };
}

async function persistCachedTaskTerminal(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<DurableTaskTerminal | undefined> {
    if (deps?.sessionManager === undefined) return undefined;
    const result = await reconcileSnapshotMutation({
        session: deps.sessionManager,
        tenantId: input.tenantId,
        sessionId: input.taskId,
        agentId: segment.agentId ?? input.agentId,
        operation: 'task.terminal.cache_hit',
        mutate: ({ snapshot, storageNow }) => {
            const status = statusForTerminalBoundary(segment, storageNow);
            const claim = claimTaskTerminalInSnapshot(snapshot, {
                taskId: input.taskId,
                state: status.state,
                claimedAt: storageNow,
                status,
                ...(segment.boundary.kind === 'canceled' && segment.boundary.reason !== undefined
                    ? { reason: segment.boundary.reason }
                    : {}),
            });
            const settled = input.recoveryGeneration !== undefined &&
                input.recoveryDeliveryKey !== undefined
                ? settleUnclaimedTaskTurnInSnapshot({
                    snapshot: claim.snapshot,
                    tenantId: input.tenantId,
                    taskId: input.taskId,
                    generation: input.recoveryGeneration,
                    deliveryKey: input.recoveryDeliveryKey,
                })
                : { snapshot: claim.snapshot, changed: false };
            return claim.changed || settled.changed
                ? { kind: 'write' as const, snapshot: settled.snapshot, value: claim.terminal }
                : { kind: 'noop' as const, value: claim.terminal };
        },
    });
    return result.value;
}

async function readPersistedTaskTerminal(
    input: TaskTaskInput,
    deps?: TaskTaskDeps
): Promise<DurableTaskTerminal | undefined> {
    if (deps?.sessionManager === undefined) return undefined;
    const loaded = await deps.sessionManager.load(input.tenantId, input.taskId);
    return readDurableTaskTerminal(loaded?.snapshot);
}

function segmentFromDurableTerminal(
    segment: SegmentTaskOutput,
    terminal: DurableTaskTerminal
): SegmentTaskOutput {
    const boundary: SegmentTaskBoundary = terminal.state === 'completed'
        ? { kind: 'complete', result: terminal.status.metadata?.result as JsonValue }
        : terminal.state === 'canceled'
          ? { kind: 'canceled', reason: terminal.status.metadata?.reason as string | undefined }
          : { kind: 'fail', error: terminal.status.metadata?.error as JsonValue };
    return { ...segment, boundary };
}

async function projectTerminalSegment(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<SegmentTaskOutput> {
    if (!isCacheOriginSegment(segment)) {
        await writeDurableResultCache(input, segment, deps);
        await finalizeRootRun(input, segment, deps);
        await notifyPersistedA2AParentIfTerminal(input, segment, deps);
        return segment;
    }

    // A cache hit has no segment turn to persist the terminal claim. Prepare the
    // cached value before the claim so working memory never receives local or
    // oversized artifact content, then let an existing terminal winner prevail.
    const existingTerminal = await readPersistedTaskTerminal(input, deps);
    const preparedSegment = existingTerminal === undefined
        ? await prepareCachedTerminalSegment(input, segment, deps)
        : segmentFromDurableTerminal(segment, existingTerminal);
    const terminal = existingTerminal ?? await persistCachedTaskTerminal(input, preparedSegment, deps);
    const authoritativeSegment = terminal === undefined
        ? preparedSegment
        : segmentFromDurableTerminal(preparedSegment, terminal);
    await writeDurableResultCache(input, authoritativeSegment, deps);
    await notifyPersistedA2AParentIfTerminal(input, authoritativeSegment, deps);
    await finalizeRootRun(input, authoritativeSegment, deps);
    return authoritativeSegment;
}

async function writeDurableResultCache(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    const cacheConfig = resolveEffectiveCacheConfig(input, deps);
    const boundary = segment.boundary;
    if (!cacheConfig.enabled || input.agentId === undefined || !isSuccessfulCompleteBoundary(boundary)) {
        return;
    }
    const cache = resolveResultCache(input, deps);
    if (cache === undefined) {
        return;
    }

    try {
        const preparedResult = await prepareChildResultForPersistence(
            boundary.result,
            cache as AgentResultCache,
            input.tenantId
        );
        await cache.setCachedResult(
            input.agentId,
            input.input as never,
            preparedResult,
            cacheConfig.ttlSeconds ?? 300,
            cacheConfig.excludePaths ?? [],
            input.tenantId
        );
    } catch (error) {
        log.warn('Failed to write durable task result cache', {
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function resolveEffectiveCacheConfig(
    input: TaskTaskInput,
    deps?: TaskTaskDeps
): Required<RuntimeResultCachePolicy> {
    const manifest = deps?.resolveCacheConfig?.(input.agentId) ?? {};
    return {
        enabled: input.cache?.enabled ?? manifest.enabled ?? false,
        ttlSeconds: input.cache?.ttlSeconds ?? manifest.ttlSeconds ?? 300,
        excludePaths: input.cache?.excludePaths ?? manifest.excludePaths ?? [],
    };
}

function resolveResultCache(input: TaskTaskInput, deps?: TaskTaskDeps): TaskResultCache | undefined {
    if (deps?.agentResultCache !== undefined) {
        return deps.agentResultCache;
    }
    if (deps?.prisma === undefined) {
        return undefined;
    }
    return new AgentResultCache(deps.prisma as never);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTaskEntityLike(value: unknown): value is {
    id: string;
    status?: { state?: string; metadata?: { result?: unknown } };
} {
    return isRecord(value) && typeof value.id === 'string' && isRecord(value.status);
}

function normalizeDurableCacheableResult(value: unknown): { cacheable: boolean; result?: unknown } {
    if (!isTaskEntityLike(value)) {
        return { cacheable: true, result: value };
    }
    if (value.status?.state !== 'completed') {
        return { cacheable: false };
    }
    const result = value.status.metadata?.result;
    return result === undefined
        ? { cacheable: false }
        : { cacheable: true, result };
}

function isSuccessfulCompleteBoundary(
    boundary: SegmentTaskBoundary
): boundary is Extract<SegmentTaskBoundary, { kind: 'complete' }> {
    return boundary.kind === 'complete' && !hasOkFalse(boundary.result);
}

async function finalizeRootRun(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    if (deps?.driverRuns === undefined) {
        return;
    }

    await deps.driverRuns.finalizeRootRun({
        tenantId: input.tenantId,
        taskId: input.taskId,
        status: statusFromTerminalBoundary(segment.boundary),
        agentId: segment.agentId ?? input.agentId ?? null,
        traceId: segment.traceId ?? null,
        boundaryKind: segment.boundary.kind,
        turnTraceId: segment.turnTraceId ?? null,
        error: errorFromTerminalBoundary(segment.boundary),
    });
}

async function finalizeRootRunAsFailed(
    input: TaskTaskInput,
    deps?: TaskTaskDeps,
    error?: unknown
): Promise<void> {
    if (deps?.driverRuns === undefined) {
        return;
    }

    await deps.driverRuns.finalizeRootRun({
        tenantId: input.tenantId,
        taskId: input.taskId,
        status: 'failed',
        agentId: input.agentId ?? null,
        boundaryKind: 'fail',
        error: serializeDriverRunError(error),
    });
}

async function convergeFailedProviderTerminal(
    input: TaskTaskInput,
    deps: TaskTaskDeps | undefined,
    error: unknown,
): Promise<void> {
    if (deps?.sessionManager === undefined) return;
    await convergeProviderTerminal(deps.sessionManager as SessionManager, {
        tenantId: input.tenantId,
        taskId: input.taskId,
        agentId: input.agentId,
        error,
        observedAt: new Date(),
        source: 'provider_callback',
    });
}

async function finalizeRootRunAsCanceled(
    input: TaskTaskInput,
    deps?: TaskTaskDeps
): Promise<void> {
    if (deps?.driverRuns === undefined) {
        return;
    }

    await deps.driverRuns.finalizeRootRun({
        tenantId: input.tenantId,
        taskId: input.taskId,
        status: 'canceled',
        agentId: input.agentId ?? null,
        boundaryKind: 'canceled',
    });
}

function isTerminalBoundary(boundary: SegmentTaskBoundary): boolean {
    return boundary.kind === 'complete' || boundary.kind === 'fail' || boundary.kind === 'canceled';
}

function statusFromTerminalBoundary(boundary: SegmentTaskBoundary): 'completed' | 'failed' | 'canceled' {
    if (boundary.kind === 'canceled') {
        return 'canceled';
    }
    if (boundary.kind === 'fail') {
        return 'failed';
    }
    if (boundary.kind === 'complete') {
        return hasOkFalse(boundary.result) ? 'failed' : 'completed';
    }
    return 'failed';
}

function hasOkFalse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (value as Record<string, unknown>).ok === false;
}

function errorFromTerminalBoundary(boundary: SegmentTaskBoundary): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (boundary.kind === 'fail') {
        return toPrismaJson(boundary.error);
    }
    if (boundary.kind !== 'complete' || !hasOkFalse(boundary.result)) {
        return undefined;
    }
    if (boundary.result && typeof boundary.result === 'object' && !Array.isArray(boundary.result)) {
        const result = boundary.result as Record<string, unknown>;
        return toPrismaJson((result.error ?? result) as JsonValue);
    }
    return toPrismaJson(boundary.result);
}

function toPrismaJson(value: JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

function isHatchetDurableEvictionAbort(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const message = typeof record.message === 'string' ? record.message : '';
    const stack = typeof record.stack === 'string' ? record.stack : '';
    return (
        name === 'AbortError' &&
        message.includes('Operation cancelled by AbortSignal') &&
        stack.includes('DurableEvictionManager')
    );
}

async function isOperatorCancellationAbort(
    input: TaskTaskInput,
    deps: TaskTaskDeps | undefined,
    error: unknown
): Promise<boolean> {
    if (!isHatchetAbortSignalError(error) || deps?.prisma?.wMSession === undefined) {
        return false;
    }
    const row = await deps.prisma.wMSession.findUnique({
        where: {
            tenantId_sessionId: {
                tenantId: input.tenantId,
                sessionId: input.taskId,
            },
        },
        select: { snapshot: true },
    });
    return readSegmentCancellation(row?.snapshot) !== undefined;
}

async function isOperatorCancellationAbortRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    deps: TaskTaskDeps | undefined,
    error: unknown,
    key: string
): Promise<boolean> {
    if (!isHatchetAbortSignalError(error)) return false;
    const inspected = await runTaskState(ctx, input, deps, {
        operation: 'inspect_cancellation', task: input,
    }, `cancellation:${key}`);
    return inspected !== undefined
        ? inspected.operatorCanceled === true
        : isOperatorCancellationAbort(input, deps, error);
}

function isHatchetAbortSignalError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const record = error as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const message = typeof record.message === 'string' ? record.message : '';
    return name === 'AbortError' && message.includes('Operation cancelled by AbortSignal');
}

async function notifyPersistedA2AParentIfTerminal(
    input: TaskTaskInput,
    _segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    if (deps?.prisma?.wMSession === undefined) {
        return;
    }

    const row = await deps.prisma.wMSession.findUnique({
        where: {
            tenantId_sessionId: {
                tenantId: input.tenantId,
                sessionId: input.taskId,
            },
        },
        select: { snapshot: true },
    });
    const snapshot = jsonObjectOrEmpty(row?.snapshot ?? null);
    const durableTerminal = readDurableTaskTerminal(snapshot as Record<string, unknown>);
    if (durableTerminal === undefined) return;
    const meta = jsonObjectOrEmpty((snapshot.meta ?? null) as JsonValue);
    const parent = jsonObjectOrEmpty((meta.a2aParent ?? null) as JsonValue);
    const parentTenantId =
        typeof parent.parentTenantId === 'string' ? parent.parentTenantId : undefined;
    const parentTaskId =
        typeof parent.parentTaskId === 'string' ? parent.parentTaskId : undefined;
    const parentChildToken =
        typeof parent.parentChildToken === 'string' ? parent.parentChildToken : undefined;

    if (!parentTenantId || !parentTaskId || !parentChildToken) {
        return;
    }

    const idempotencyKey = `${parentTaskId}:child:${parentChildToken}`;
    const completedAt = new Date().toISOString();
    const durableStatus = durableTerminal.status;
    const cacheOrigin = durableStatus.metadata?.origin === 'cache' ||
        durableStatus.metadata?.source === 'cache';
    const output = durableTerminal.state === 'completed'
        ? durableStatus.metadata?.result
        : {
              error: durableStatus.metadata?.error ??
                  durableStatus.metadata?.reason ??
                  durableStatus.message ??
                  `Child task ${durableTerminal.state}.`,
          };
    const childResultForParent = await prepareChildResultForPersistence(
        output,
        deps.prisma ? new AgentResultCache(deps.prisma as never) : undefined,
        parentTenantId
    );
    if (deps.sessionManager === undefined) return;
    const failure = durableTerminal.state === 'completed'
        ? undefined
        : (childResultForParent as { error?: unknown })?.error ?? childResultForParent;
    const normalizedFailure =
        failure !== null && typeof failure === 'object' && !Array.isArray(failure)
            ? {
                  code: typeof (failure as any).code === 'string' ? (failure as any).code : 'CHILD_FAILED',
                  message: typeof (failure as any).message === 'string'
                      ? (failure as any).message
                      : String(failure),
              }
            : { code: 'CHILD_FAILED', message: String(failure ?? 'Child failed.') };
    const claim = await coordinateChildTerminal({
        session: deps.sessionManager,
        tenantId: parentTenantId,
        parentTaskId,
        deliveryMode: 'async_wake',
        runtimeSurface: 'hatchet',
        request: durableTerminal.state === 'completed'
            ? {
                  kind: 'completed', token: parentChildToken, completedAt,
                  childTaskId: input.taskId, agentId: input.agentId,
                  result: childResultForParent,
                  ...(cacheOrigin ? { executionMetadata: { origin: 'cache' as const } } : {}),
                  ...(durableTerminal.turnClaim !== undefined
                      ? { terminalIdentity: durableTerminal.turnClaim }
                      : {}),
              }
            : {
                  kind: 'failed', token: parentChildToken, failedAt: completedAt,
                  childTaskId: input.taskId, agentId: input.agentId,
                  error: normalizedFailure,
                  ...(durableTerminal.turnClaim !== undefined
                      ? { terminalIdentity: durableTerminal.turnClaim }
                      : {}),
              },
    });
    if ((claim.publicationDisposition !== 'new_delivery' &&
        claim.publicationDisposition !== 'matching_replay') || claim.observation === undefined) return;
    const publicationKind = claim.kind ??
        (claim.observation.kind === 'child.completed' ? 'completed' : 'failed');
    const publicationPayload = claim.observation.payload as {
        result?: unknown;
        error?: unknown;
    };
    await deps.runtimeTimers?.cancelTaskTimers({
        tenantId: parentTenantId,
        taskId: parentTaskId,
        token: parentChildToken,
    });
    if (deps.events === undefined || shouldSuppressChildWakeForDrill(parentTaskId)) {
        return;
    }

    await deps.events.push(
        `aplret.child.${parentChildToken}`,
        {
            tenantId: parentTenantId,
            taskId: parentTaskId,
            agentId: input.agentId,
            idempotencyKey,
            kind: 'child',
            token: parentChildToken,
            childTaskId: input.taskId,
            outcome: publicationKind,
            ...(publicationKind === 'completed'
                ? { output: publicationPayload.result }
                : { error: publicationPayload.error }),
            completedAt,
            terminalClaimed: true,
        },
        { key: `${parentTenantId}:${parentTaskId}:${parentChildToken}` }
    );
}

function shouldSuppressChildWakeForDrill(parentTaskId: string): boolean {
    return taskIdMatchesPrefixEnv(parentTaskId, 'CALLAGENT_HATCHET_SUPPRESS_CHILD_WAKE_PREFIX');
}

function shouldSuppressChildTerminalRecoveryForDrill(parentTaskId: string): boolean {
    return taskIdMatchesPrefixEnv(parentTaskId, 'CALLAGENT_HATCHET_SUPPRESS_CHILD_TERMINAL_RECOVERY_PREFIX');
}

function taskIdMatchesPrefixEnv(taskId: string, envName: string): boolean {
    const raw = process.env[envName];
    if (raw === undefined || raw.trim().length === 0) {
        return false;
    }
    return raw
        .split(',')
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0)
        .some((prefix) => taskId.startsWith(prefix));
}

function outputFromTerminalBoundary(boundary: SegmentTaskBoundary): unknown {
    if (boundary.kind === 'complete') {
        return boundary.result;
    }
    if (boundary.kind === 'fail') {
        return {
            ok: false,
            error: boundary.error,
        };
    }
    if (boundary.kind === 'canceled') {
        return {
            ok: false,
            canceled: true,
            reason: boundary.reason,
        };
    }
    return {
        ok: false,
        error: { code: 'NON_TERMINAL_BOUNDARY', message: `Unexpected boundary: ${boundary.kind}` },
    };
}

async function dispatchPendingOutboxChildren(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    const state = await runTaskState(ctx, input, deps, {
        operation: 'list_outbox', task: input, segment,
    }, `outbox:${segment.turnSeq ?? 0}:${segment.claimedGeneration ?? 'unknown'}`);
    const children = state !== undefined
        ? state.outboxChildren ?? []
        : await listPendingOutboxChildren(input, segment, deps);

    await Promise.all(
        children.map((childInput) => {
            const tenantId = childInput.tenantId ?? input.tenantId;
            const taskId = childInput.taskId ?? input.taskId;
            return ctx.runNoWaitChild<OutboxDispatchInput, OutboxDispatchOutput>(
                OUTBOX_DISPATCH_TASK_NAME,
                childInput,
                {
                key: childInput.outboxRowId,
                additionalMetadata: {
                    operation: 'effect.outbox.dispatch',
                    tenantId,
                    taskId,
                    rootTaskId: input.taskId,
                    tenantTaskKey: `${tenantId}:${taskId}`,
                    outboxRowId: childInput.outboxRowId,
                    eventType: childInput.eventType,
                    ...(childInput.agentId !== undefined ? { agentId: childInput.agentId } : {}),
                    ...(childInput.traceId !== undefined ? { traceId: childInput.traceId } : {}),
                    ...(childInput.token !== undefined ? { token: childInput.token } : {}),
                },
            });
        })
    );
}

async function listPendingOutboxChildren(
    input: TaskTaskInput,
    segment: SegmentTaskOutput | undefined,
    deps?: TaskTaskDeps
): Promise<OutboxDispatchInput[]> {
    if (deps?.prisma === undefined) return [];
    const rows = await deps.prisma.outbox.findMany({
        where: {
            tenantId: input.tenantId,
            key: input.taskId,
            topic: { in: ['task.status', 'task.input_required', 'task.child_dispatch'] },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });

    return rows.map((row) => {
            const payload = jsonObjectOrEmpty(row.payload);
            const token = typeof payload.token === 'string' ? payload.token : undefined;
            const traceId = typeof payload.traceId === 'string' ? payload.traceId : undefined;
            const agentId =
                typeof payload.agentId === 'string'
                    ? payload.agentId
                    : segment?.agentId ?? input.agentId;
            return {
                outboxRowId: row.id,
                eventType: row.topic,
                tenantId: row.tenantId,
                taskId: row.key,
                ...(agentId !== undefined ? { agentId } : {}),
                ...(traceId !== undefined ? { traceId } : {}),
                ...(token !== undefined ? { token } : {}),
            } satisfies OutboxDispatchInput;
        });
}

function jsonObjectOrEmpty(value: JsonValue): JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

function normalizeSegmentOutput(
    output: unknown,
    segmentTaskName: string = SEGMENT_TASK_NAME
): SegmentTaskOutput {
    if (isSegmentTaskOutput(output)) {
        return output;
    }
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        const record = output as Record<string, unknown>;
        const wrapped = record[segmentTaskName];
        if (isSegmentTaskOutput(wrapped)) {
            return wrapped;
        }
    }
    throw new Error('SEGMENT_OUTPUT_INVALID');
}

function normalizeTaskStateOutput(
    output: unknown,
    taskStateName: string = TASK_STATE_TASK_NAME
): TaskStateOutput {
    if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        throw new Error('TASK_STATE_OUTPUT_INVALID');
    }
    const record = output as Record<string, unknown>;
    const wrapped = record[taskStateName];
    if (wrapped !== undefined) {
        if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
            throw new Error('TASK_STATE_OUTPUT_INVALID');
        }
        return wrapped as TaskStateOutput;
    }
    return record as TaskStateOutput;
}

function isSegmentTaskOutput(value: unknown): value is SegmentTaskOutput {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    const boundary = record.boundary;
    return (
        typeof record.tenantId === 'string' &&
        typeof record.taskId === 'string' &&
        boundary !== null &&
        typeof boundary === 'object' &&
        !Array.isArray(boundary) &&
        typeof (boundary as Record<string, unknown>).kind === 'string'
    );
}

function buildTaskRunMetadata(
    input: TaskTaskInput,
    segmentInput: SegmentTaskInput
): Record<string, string> {
    const metadata: Record<string, string> = {
        operation: 'turn.segment',
        tenantId: input.tenantId,
        taskId: input.taskId,
        rootTaskId: input.rootTaskId ?? input.taskId,
        tenantTaskKey: `${input.tenantId}:${input.taskId}`,
        idempotencyKey: segmentInput.idempotencyKey,
        turnSeq: String(segmentInput.turnSeq ?? ''),
    };
    if (input.agentId !== undefined) {
        metadata.agentId = input.agentId;
    }
    if (input.parentTaskId !== undefined) {
        metadata.parentTaskId = input.parentTaskId;
    }
    return metadata;
}

async function waitForBoundaryEvent(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (boundary.kind === 'await_input' && boundary.expiresAt !== undefined) {
        return waitForInputOrTimer(ctx, input, boundary, deps);
    }

    if (boundary.kind === 'await_child') {
        if (boundary.expiresAt !== undefined) {
            return waitForChildOrTimer(ctx, input, boundary, deps);
        }
        return waitForChildBoundaryEvent(ctx, input, boundary, deps);
    }

    const eventKind =
        boundary.kind === 'await_input'
            ? 'input'
            : boundary.kind === 'await_tool'
              ? 'tool'
              : 'external';
    const payload = await ctx.waitForEvent(
        `aplret.${eventKind}.${boundary.token}`,
        `input.tenantId == "${input.tenantId}" && input.taskId == "${input.taskId}"`,
        undefined,
        undefined,
        BOUNDARY_EVENT_LOOKBACK,
        `wait:${eventKind}:${boundary.token}`
    );
    return normalizeWakeEvent(eventKind, boundary.token, payload);
}

async function waitForChildOrTimer(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (boundary.expiresAt === undefined) throw new Error('CHILD_TIMER_EXPIRES_AT_MISSING');
    const timer = await scheduleBoundaryTimerRecorded(ctx, input, boundary, deps, 'child_timeout');
    const winner = await waitForBoundaryRace(ctx, {
        eventKey: `aplret.child.${boundary.token}`,
        timerKey: `aplret.timer.${boundary.token}`,
        expression: `input.tenantId == "${input.tenantId}" && input.taskId == "${input.taskId}"`,
        fireAt: boundary.expiresAt,
        inputReadableKey: 'child',
        timerReadableKey: 'timer',
        label: `wait:child-or-timer:${boundary.token}`,
    });
    if (winner.kind === 'timer') {
        const persistedChild = await findPersistedBoundaryEventRecorded(
            ctx,
            input,
            boundary,
            deps,
            `timer-race:${boundary.token}`
        );
        if (persistedChild !== undefined) {
            await cancelBoundaryTimersRecorded(ctx, input, boundary.token, deps);
            return persistedChild;
        }
        const firedAt = await markBoundaryTimerFiredRecorded(ctx, input, boundary.token, timer, deps);
        return {
            kind: 'timer',
            token: boundary.token,
            timerId: timer.timerId,
            dueAt: timer.dueAt.toISOString(),
            firedAt,
            reason: 'child_timeout',
            payload: timer.payload ?? {
                token: boundary.token,
                timeoutMs: boundary.timeoutMs,
                childTaskId: boundary.childTaskId,
                agentId: boundary.agentId,
            },
            idempotencyKey: timer.idempotencyKey,
        };
    }
    await cancelBoundaryTimersRecorded(ctx, input, boundary.token, deps);
    return normalizeWakeEvent('child', boundary.token, winner.payload);
}

async function waitForChildBoundaryEvent(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    const eventKey = `aplret.child.${boundary.token}`;
    const expression = `input.tenantId == "${input.tenantId}" && input.taskId == "${input.taskId}"`;
    const intervalMs = readPositiveMsEnv(
        'CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS',
        DEFAULT_AWAIT_CHILD_RECOVERY_INTERVAL_MS
    );
    const maxWaitMs = readPositiveMsEnv(
        'CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS',
        DEFAULT_AWAIT_CHILD_MAX_WAIT_MS
    );
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / intervalMs));
    let attempt = 0;

    for (;;) {
        const waitable = Or(
            new UserEventCondition(eventKey, expression, 'child'),
            new SleepCondition(durationFromMs(intervalMs), 'watchdog')
        );
        const result = await ctx.waitFor(waitable, `wait:child-or-watchdog:${boundary.token}:${attempt}`);
        const extracted = extractWaitResult(result);
        if (extracted.key === 'child') {
            return normalizeWakeEvent('child', boundary.token, extracted.payload);
        }

        const persisted = await findPersistedBoundaryEventRecorded(
            ctx, input, boundary, deps, `watchdog:${boundary.token}:${attempt}`
        );
        if (persisted !== undefined) {
            return persisted;
        }

        if (attempt + 1 >= maxAttempts) {
            const state = await runTaskState(ctx, input, deps, {
                operation: 'find_child_task_id', task: input, boundary,
            }, `child-id:${boundary.token}:${attempt}`);
            const childTaskId = state !== undefined
                ? state.childTaskId
                : await findPersistedChildTaskId(input, boundary, deps ?? {});
            return childWake(input, boundary.token, childTaskId ?? boundary.token, {
                ok: false,
                error: {
                    code: 'CHILD_WAKE_TIMEOUT',
                    message: `Timed out waiting for child wake for token ${boundary.token}.`,
                },
            });
        }

        attempt += 1;
    }
}

async function waitForInputOrTimer(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: Extract<SegmentTaskBoundary, { kind: 'await_input' }>,
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (boundary.expiresAt === undefined) {
        throw new Error('TIMER_EXPIRES_AT_MISSING');
    }
    const timer = await scheduleBoundaryTimerRecorded(ctx, input, boundary, deps, 'token_expiry');
    const inputKey = `aplret.input.${boundary.token}`;
    const timerKey = `aplret.timer.${boundary.token}`;
    const expression = `input.tenantId == "${input.tenantId}" && input.taskId == "${input.taskId}"`;
    const winner = await waitForBoundaryRace(ctx, {
        eventKey: inputKey,
        timerKey,
        expression,
        fireAt: boundary.expiresAt,
        inputReadableKey: 'input',
        timerReadableKey: 'timer',
        label: `wait:input-or-timer:${boundary.token}`,
    });

    if (winner.kind === 'timer') {
        const firedAt = await markBoundaryTimerFiredRecorded(ctx, input, boundary.token, timer, deps);
        return {
            kind: 'timer',
            token: boundary.token,
            timerId: timer.timerId,
            dueAt: timer.dueAt.toISOString(),
            firedAt,
            reason: timerKindToReason(timer.kind),
            ...(timer.payload !== null && timer.payload !== undefined ? { payload: timer.payload } : {}),
            idempotencyKey: timer.idempotencyKey,
        };
    }

    await cancelBoundaryTimersRecorded(ctx, input, boundary.token, deps);
    return normalizeWakeEvent('input', boundary.token, winner.payload);
}

async function waitForSleepBoundary(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: Extract<SegmentTaskBoundary, { kind: 'sleep' }>,
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (deps?.runtimeTimers === undefined && deps?.useTaskStateChildren !== true) {
        await ctx.sleepUntil(new Date(boundary.fireAt));
        const firedAt = new Date().toISOString();
        return {
            kind: 'timer',
            token: boundary.token,
            timerId: boundary.timerId ?? `${input.taskId}:sleep:${boundary.token}`,
            dueAt: boundary.fireAt,
            firedAt,
            reason: 'sleep_due',
            ...(boundary.payload !== undefined ? { payload: boundary.payload } : {}),
            idempotencyKey: `${input.taskId}:sleep:${boundary.token}`,
        };
    }
    const timer = await scheduleBoundaryTimerRecorded(ctx, input, boundary, deps, 'sleep');
    const winner = await waitForBoundaryRace(ctx, {
        timerKey: `aplret.timer.${boundary.token}`,
        fireAt: boundary.fireAt,
        timerReadableKey: 'timer',
        label: `wait:sleep:${boundary.token}`,
    });
    const firedAt = await markBoundaryTimerFiredRecorded(ctx, input, boundary.token, timer, deps);
    if (winner.kind === 'timer' && winner.payload.kind === 'timer') {
        return normalizeTimerWake(boundary.token, winner.payload, timer);
    }
    return {
        kind: 'timer',
        token: boundary.token,
        timerId: timer.timerId,
        dueAt: timer.dueAt.toISOString(),
        firedAt,
        reason: timerKindToReason(timer.kind),
        ...(timer.payload !== null && timer.payload !== undefined ? { payload: timer.payload } : {}),
        idempotencyKey: timer.idempotencyKey,
    };
}

async function scheduleBoundaryTimer(
    input: TaskTaskInput,
    boundary: TimerBoundary,
    runtimeTimers: RuntimeTimerRepository,
    kind: 'token_expiry' | 'sleep' | 'child_timeout'
): Promise<RuntimeTimerRecord> {
    const fireAt = boundary.kind === 'sleep' ? boundary.fireAt : boundary.expiresAt;
    if (fireAt === undefined) {
        throw new Error('TIMER_FIRE_AT_MISSING');
    }
    return runtimeTimers.schedule({
        tenantId: input.tenantId,
        taskId: input.taskId,
        agentId: input.agentId,
        token: boundary.token,
        idempotencyKey: input.idempotencyKey,
        fireAt,
        kind,
        ...(boundary.kind === 'sleep' && boundary.payload !== undefined
            ? { payload: boundary.payload }
            : boundary.kind === 'await_child'
              ? {
                    payload: {
                        token: boundary.token,
                        timeoutMs: boundary.timeoutMs,
                        childTaskId: boundary.childTaskId,
                        agentId: boundary.agentId,
                    },
                }
              : {}),
    });
}

async function scheduleBoundaryTimerRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: TimerBoundary,
    deps: TaskTaskDeps | undefined,
    kind: 'token_expiry' | 'sleep' | 'child_timeout'
): Promise<RuntimeTimerRecord> {
    const state = await runTaskState(ctx, input, deps, {
        operation: 'schedule_timer', task: input, boundary, timerKind: kind,
    }, `timer:schedule:${kind}:${boundary.token}`);
    if (state?.timer !== undefined) {
        const dueAt = new Date(state.timer.dueAt);
        return {
            id: state.timer.timerId,
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId ?? null,
            rootTaskId: input.rootTaskId ?? input.taskId,
            token: boundary.token,
            timerId: state.timer.timerId,
            dueAt,
            kind: state.timer.kind,
            status: 'scheduled',
            idempotencyKey: state.timer.idempotencyKey,
            fireLeaseId: null,
            fireLeaseUntil: null,
            payload: state.timer.payload,
            providerRunId: null,
            providerTaskRunId: null,
            error: null,
            firedAt: null,
            canceledAt: null,
            createdAt: dueAt,
            updatedAt: dueAt,
        };
    }
    if (deps?.runtimeTimers === undefined) throw new Error('RUNTIME_TIMER_REPOSITORY_MISSING');
    return scheduleBoundaryTimer(input, boundary, deps.runtimeTimers, kind);
}

async function markBoundaryTimerFiredRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    token: string,
    timer: RuntimeTimerRecord,
    deps?: TaskTaskDeps
): Promise<string> {
    const state = await runTaskState(ctx, input, deps, {
        operation: 'mark_timer_fired', task: input, token, timerId: timer.timerId,
    }, `timer:fired:${timer.timerId}`);
    if (state !== undefined) return state.firedAt ?? timer.dueAt.toISOString();
    const firedAt = new Date().toISOString();
    await deps?.runtimeTimers?.markFiredByTimerId({
        tenantId: input.tenantId, taskId: input.taskId, token,
        timerId: timer.timerId, firedAt: new Date(firedAt),
    });
    return firedAt;
}

async function cancelBoundaryTimersRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    token: string,
    deps?: TaskTaskDeps
): Promise<void> {
    const state = await runTaskState(ctx, input, deps, {
        operation: 'cancel_timers', task: input, token,
    }, `timer:cancel:${token}`);
    if (state !== undefined) return;
    await deps?.runtimeTimers?.cancelTaskTimers({
        tenantId: input.tenantId, taskId: input.taskId, token,
    });
}

type BoundaryRaceResult =
    | { kind: 'input'; payload: Record<string, unknown> }
    | { kind: 'timer'; payload: Record<string, unknown> };

async function waitForBoundaryRace(
    ctx: DurableContext<TaskTaskInput>,
    params: {
        eventKey?: string;
        timerKey: string;
        expression?: string;
        fireAt: string;
        inputReadableKey?: string;
        timerReadableKey: string;
        label: string;
    }
): Promise<BoundaryRaceResult> {
    const timerEvent = new UserEventCondition(params.timerKey, params.expression ?? '', params.timerReadableKey);
    const sleep = new SleepCondition(durationUntil(params.fireAt), params.timerReadableKey);
    const waitable = params.eventKey === undefined
        ? Or(sleep, timerEvent)
        : Or(
            new UserEventCondition(params.eventKey, params.expression ?? '', params.inputReadableKey ?? 'input'),
            sleep,
            timerEvent
        );
    const result = await ctx.waitFor(waitable, params.label);
    const extracted = extractWaitResult(result);
    if (extracted.key === (params.inputReadableKey ?? 'input')) {
        return { kind: 'input', payload: extracted.payload };
    }
    return { kind: 'timer', payload: extracted.payload };
}

function extractWaitResult(value: Record<string, unknown>): { key: string; payload: Record<string, unknown> } {
    const [key] = Object.keys(value);
    if (key === undefined) {
        return { key: 'timer', payload: {} };
    }
    const raw = value[key];
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        const [eventId] = Object.keys(record);
        if (eventId !== undefined) {
            const payload = record[eventId];
            return { key, payload: jsonObjectOrEmpty(payload as JsonValue) };
        }
        return { key, payload: record };
    }
    return { key, payload: {} };
}

function durationUntil(fireAt: string): Duration {
    const remainingMs = Date.parse(fireAt) - Date.now();
    return durationFromMs(remainingMs);
}

function durationFromMs(ms: number): Duration {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return `${seconds}s` as Duration;
}

function readPositiveMsEnv(name: string, fallback: number): number {
    const raw = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function findPersistedBoundaryEvent(
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    deps?: TaskTaskDeps
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    if (boundary.kind !== 'await_child') {
        return undefined;
    }

    return await findPersistedParentChildSnapshot(input, boundary, deps)
        ?? await findPersistedParentChildEvent(input, boundary, deps ?? {})
        ?? await findPersistedChildTerminalEvent(input, boundary, deps);
}

async function findPersistedBoundaryEventRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    deps: TaskTaskDeps | undefined,
    key: string
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    const state = await runTaskState(ctx, input, deps, {
        operation: 'find_boundary_event', task: input, boundary,
    }, `boundary:${key}`);
    return state !== undefined
        ? state.event
        : findPersistedBoundaryEvent(input, boundary, deps);
}

async function findPersistedParentChildSnapshot(
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps?: TaskTaskDeps
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    if (deps?.prisma?.wMSession === undefined || shouldSuppressChildTerminalRecoveryForDrill(input.taskId)) {
        return undefined;
    }
    const row = await deps.prisma.wMSession.findUnique({
        where: {
            tenantId_sessionId: { tenantId: input.tenantId, sessionId: input.taskId },
        },
        select: { snapshot: true },
    });
    const snapshot = jsonObjectOrEmpty(row?.snapshot ?? null);
    const pending = jsonObjectOrEmpty(snapshot.pending as JsonValue);
    const terminals = jsonObjectOrEmpty(pending.childTerminals as JsonValue);
    const terminal = jsonObjectOrEmpty(terminals[boundary.token] as JsonValue);
    if (terminal.kind !== 'completed' && terminal.kind !== 'failed') return undefined;

    const inbox = jsonObjectOrEmpty(snapshot.inbox as JsonValue);
    const observations = [
        ...(Array.isArray(inbox.current) ? inbox.current : []),
        ...(Array.isArray(inbox.all) ? inbox.all : []),
    ];
    const observation = observations.find((candidate) => {
        const record = jsonObjectOrEmpty(candidate as JsonValue);
        const payload = jsonObjectOrEmpty(record.payload as JsonValue);
        return payload.token === boundary.token &&
            (record.kind === 'child.completed' || record.kind === 'child.failed');
    });
    if (observation === undefined) return undefined;
    const payload = jsonObjectOrEmpty(
        jsonObjectOrEmpty(observation as JsonValue).payload as JsonValue
    );
    const childTaskId = typeof payload.childTaskId === 'string'
        ? payload.childTaskId
        : typeof terminal.childTaskId === 'string'
          ? terminal.childTaskId
          : boundary.childTaskId ?? boundary.token;
    return {
        kind: 'child',
        token: boundary.token,
        childTaskId,
        outcome: terminal.kind,
        ...(terminal.kind === 'completed'
            ? { output: payload.result as never }
            : { error: payload.error as never }),
        terminalClaimed: true,
        idempotencyKey: `${input.taskId}:child:${boundary.token}`,
    };
}

async function findPersistedParentChildEvent(
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps: TaskTaskDeps
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    if (deps.prisma?.wMEvent === undefined) {
        return undefined;
    }

    const rows = await deps.prisma.wMEvent.findMany({
        where: {
            tenantId: input.tenantId,
            sessionId: input.taskId,
            type: { in: ['task.child_completed', 'task.child_failed'] },
        },
        orderBy: { seq: 'desc' },
        take: 100,
    });

    const row = rows.find((candidate) => {
        const payload = jsonObjectOrEmpty(candidate.payload);
        return payload.token === boundary.token;
    });
    if (row === undefined) {
        return undefined;
    }

    const payload = jsonObjectOrEmpty(row.payload);
    if (row.type === 'task.child_failed') {
        return {
            kind: 'child',
            token: boundary.token,
            childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : boundary.token,
            outcome: 'failed',
            error: payload.error as never,
            idempotencyKey: `${input.taskId}:child:${boundary.token}`,
        };
    }

    return {
        kind: 'child',
        token: boundary.token,
        childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : boundary.token,
        outcome: 'completed',
        output: 'result' in payload ? payload.result : payload.resultPreview,
        idempotencyKey: `${input.taskId}:child:${boundary.token}`,
    };
}

async function findPersistedChildTerminalEvent(
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps?: TaskTaskDeps
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    if (deps?.prisma?.wMEvent === undefined) {
        return undefined;
    }
    if (shouldSuppressChildTerminalRecoveryForDrill(input.taskId)) {
        return undefined;
    }

    const childTaskId = await findPersistedChildTaskId(input, boundary, deps);
    if (childTaskId === undefined) {
        return undefined;
    }

    const rows = await deps.prisma.wMEvent.findMany({
        where: {
            tenantId: input.tenantId,
            sessionId: childTaskId,
            type: { in: ['task.completed', 'task.failed', 'turn.completed'] },
        },
        orderBy: { seq: 'desc' },
        take: 50,
    });

    for (const row of rows) {
        const payload = jsonObjectOrEmpty(row.payload);
        if (row.type === 'task.failed') {
            return childWake(input, boundary.token, childTaskId, {
                ok: false,
                error: payload.error,
            });
        }
        if (row.type === 'task.completed') {
            return childWake(input, boundary.token, childTaskId, 'result' in payload ? payload.result : payload.output);
        }
        if (row.type !== 'turn.completed') {
            continue;
        }

        const transition = jsonObjectOrEmpty(payload.transition as JsonValue);
        if (transition.kind === 'complete') {
            continue;
        }
        if (transition.kind === 'fail') {
            return childWake(input, boundary.token, childTaskId, {
                ok: false,
                error: 'error' in transition ? transition.error : transition.reason,
            });
        }
    }

    return undefined;
}

async function hydratePersistedBoundaryEvent(
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    event: RuntimeWakeEvent & { idempotencyKey?: string },
    deps?: TaskTaskDeps
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (boundary.kind !== 'await_child' || event.kind !== 'child') {
        return event;
    }
    if (event.output !== undefined && event.childTaskId !== boundary.token) {
        return event;
    }
    return await findPersistedChildTerminalEvent(input, boundary, deps) ?? event;
}

async function hydratePersistedBoundaryEventRecorded(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    event: RuntimeWakeEvent & { idempotencyKey?: string },
    deps: TaskTaskDeps | undefined,
    key: string
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    if (boundary.kind !== 'await_child' || event.kind !== 'child' ||
        (event.output !== undefined && event.childTaskId !== boundary.token)) {
        return event;
    }
    const persisted = await findPersistedBoundaryEventRecorded(ctx, input, boundary, deps, key);
    return persisted ?? event;
}

async function findPersistedChildTaskId(
    input: TaskTaskInput,
    boundary: Extract<AwaitableBoundary, { kind: 'await_child' }>,
    deps: TaskTaskDeps
): Promise<string | undefined> {
    if (deps.prisma?.wMEvent === undefined) {
        return undefined;
    }

    const rows = await deps.prisma.wMEvent.findMany({
        where: {
            tenantId: input.tenantId,
            sessionId: input.taskId,
            type: { in: ['task.child_started'] },
        },
        orderBy: { seq: 'desc' },
        take: 100,
    });

    for (const row of rows) {
        if (row.type !== 'task.child_started') {
            continue;
        }
        const payload = jsonObjectOrEmpty(row.payload);
        if (payload.token !== boundary.token) {
            continue;
        }
        return typeof payload.childTaskId === 'string' ? payload.childTaskId : undefined;
    }

    return undefined;
}

function childWake(
    input: TaskTaskInput,
    token: string,
    childTaskId: string,
    output: unknown
): RuntimeWakeEvent & { idempotencyKey?: string } {
    const failed =
        output !== null &&
        typeof output === 'object' &&
        !Array.isArray(output) &&
        (output as { ok?: unknown }).ok === false;
    return {
        kind: 'child',
        token,
        childTaskId,
        outcome: failed ? 'failed' : 'completed',
        ...(failed
            ? { error: (output as { error?: unknown }).error as never }
            : { output: output as never }),
        idempotencyKey: `${input.taskId}:child:${token}`,
    };
}

async function findPersistedAwaitBoundary(
    input: TaskTaskInput,
    deps?: TaskTaskDeps
): Promise<{ boundary: AwaitableBoundary; turnSeq: number } | undefined> {
    const rows = deps?.prisma?.wMEvent === undefined
        ? []
        : await deps.prisma.wMEvent.findMany({
              where: {
                  tenantId: input.tenantId,
                  sessionId: input.taskId,
                  type: { in: ['turn.completed', 'task.completed', 'task.failed', 'task.canceled'] },
              },
              orderBy: { seq: 'desc' },
              take: 50,
          });

    for (const row of rows) {
        if (row.type === 'task.completed' || row.type === 'task.failed' || row.type === 'task.canceled') {
            return undefined;
        }
        if (row.type !== 'turn.completed') {
            continue;
        }

        const payload = jsonObjectOrEmpty(row.payload);
        let boundary = awaitableBoundaryFromTransition(payload.transition);
        if (boundary === undefined) {
            return undefined;
        }
        if (boundary.kind === 'await_child' && boundary.expiresAt === undefined && deps?.prisma?.wMSession) {
            const session = await deps.prisma.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId: input.tenantId, sessionId: input.taskId } },
                select: { snapshot: true },
            });
            const snapshot = jsonObjectOrEmpty(session?.snapshot ?? null);
            const pending = jsonObjectOrEmpty(snapshot.pending as JsonValue);
            const tasks = jsonObjectOrEmpty(pending.tasks as JsonValue);
            const entry = jsonObjectOrEmpty(tasks[boundary.token] as JsonValue);
            boundary = {
                ...boundary,
                ...(typeof entry.expiresAt === 'string' ? { expiresAt: entry.expiresAt } : {}),
                ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
                ...(typeof entry.childTaskId === 'string' ? { childTaskId: entry.childTaskId } : {}),
                ...(typeof entry.agentId === 'string' ? { agentId: entry.agentId } : {}),
            };
        }
        return {
            boundary,
            turnSeq: typeof payload.turnSeq === 'number' && Number.isFinite(payload.turnSeq)
                ? payload.turnSeq
                : 0,
        };
    }

    if (deps?.prisma?.wMSession === undefined) return undefined;
    const row = await deps.prisma.wMSession.findUnique({
        where: {
            tenantId_sessionId: { tenantId: input.tenantId, sessionId: input.taskId },
        },
        select: { snapshot: true },
    });
    const snapshot = jsonObjectOrEmpty(row?.snapshot ?? null);
    const meta = jsonObjectOrEmpty(snapshot.meta as JsonValue);
    const awaiting = jsonObjectOrEmpty(meta.awaiting as JsonValue);
    if (awaiting.kind !== 'await_child' || typeof awaiting.token !== 'string') return undefined;
    const pending = jsonObjectOrEmpty(snapshot.pending as JsonValue);
    const tasks = jsonObjectOrEmpty(pending.tasks as JsonValue);
    const entry = jsonObjectOrEmpty(tasks[awaiting.token] as JsonValue);
    return {
        boundary: {
            kind: 'await_child',
            token: awaiting.token,
            ...(typeof entry.expiresAt === 'string' ? { expiresAt: entry.expiresAt } : {}),
            ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
            ...(typeof entry.childTaskId === 'string' ? { childTaskId: entry.childTaskId } : {}),
            ...(typeof entry.agentId === 'string' ? { agentId: entry.agentId } : {}),
        },
        turnSeq: typeof meta.turn === 'number' && Number.isFinite(meta.turn) ? meta.turn : 0,
    };
}

function awaitableBoundaryFromTransition(value: unknown): AwaitableBoundary | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const token = typeof record.token === 'string' ? record.token : undefined;
    if (token === undefined || token.length === 0) {
        return undefined;
    }

    if (record.kind === 'await_input') {
        return typeof record.expiresAt === 'string'
            ? { kind: 'await_input', token, expiresAt: record.expiresAt }
            : { kind: 'await_input', token };
    }
    if (record.kind === 'await_tool') {
        return { kind: 'await_tool', token };
    }
    if (record.kind === 'await_child') {
        return {
            kind: 'await_child',
            token,
            ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
            ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
            ...(typeof record.childTaskId === 'string' ? { childTaskId: record.childTaskId } : {}),
            ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
        };
    }
    if (record.kind === 'await_event') {
        return { kind: 'await_event', token };
    }
    return undefined;
}

function normalizeWakeEvent(
    eventKind: 'input' | 'tool' | 'child' | 'external',
    token: string,
    payload: Record<string, unknown>
): RuntimeWakeEvent & { idempotencyKey?: string } {
    const idempotencyKey =
        typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined;

    if (eventKind === 'input') {
        return {
            kind: 'input',
            token,
            value: 'value' in payload ? payload.value : payload.input,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        };
    }

    if (eventKind === 'child') {
        const output = 'output' in payload ? payload.output : payload.result;
        const failed = payload.outcome === 'failed' || (output as { ok?: unknown } | undefined)?.ok === false;
        return {
            kind: 'child',
            token,
            childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : token,
            outcome: failed ? 'failed' : 'completed',
            ...(failed
                ? { error: ('error' in payload ? payload.error : (output as { error?: unknown } | undefined)?.error) as never }
                : { output: output as never }),
            ...(typeof payload.completedAt === 'string' ? { completedAt: payload.completedAt } : {}),
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        };
    }

    if (eventKind === 'external') {
        return {
            kind: 'external',
            token,
            type: typeof payload.type === 'string' ? payload.type : 'external',
            data: 'data' in payload ? payload.data : payload.payload,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        };
    }

    return {
        kind: 'tool',
        token,
        result: payload.result,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
}

function normalizeTimerWake(
    token: string,
    payload: Record<string, unknown>,
    fallback: RuntimeTimerRecord
): RuntimeWakeEvent & { idempotencyKey?: string } {
    const idempotencyKey =
        typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : fallback.idempotencyKey;
    return {
        kind: 'timer',
        token,
        timerId: typeof payload.timerId === 'string' ? payload.timerId : fallback.timerId,
        dueAt: typeof payload.dueAt === 'string' ? payload.dueAt : fallback.dueAt.toISOString(),
        firedAt: typeof payload.firedAt === 'string' ? payload.firedAt : new Date().toISOString(),
        reason:
            payload.reason === 'sleep_due'
                ? 'sleep_due'
                : payload.reason === 'child_timeout'
                  ? 'child_timeout'
                  : 'input_timeout',
        ...('payload' in payload ? { payload: payload.payload } : {}),
        idempotencyKey,
    };
}

function boundaryEventToWake(
    boundary: AwaitableBoundary,
    event: RuntimeWakeEvent
): SegmentTaskWake {
    if (event.kind === 'timer') {
        return { trigger: 'timer', event: event as SegmentEventWake['event'] };
    }
    if (boundary.kind === 'await_input') {
        return { trigger: 'resume', event: event as SegmentEventWake['event'] };
    }
    if (boundary.kind === 'await_child') {
        return { trigger: 'child', event: event as SegmentEventWake['event'] };
    }
    if (boundary.kind === 'await_event') {
        return { trigger: 'event', event: event as SegmentEventWake['event'] };
    }
    return { trigger: 'tool', event: event as SegmentEventWake['event'] };
}

export function createTaskTask(
    hatchet: HatchetClient,
    deps?: TaskTaskDeps,
    name: string = TASK_TASK_NAME,
    options?: { executionTimeout?: Duration; protocolNames?: TaskProtocolNames }
) {
    // Durable roots are orchestration-only. All stateful dependencies remain
    // available to aplret.task-state, but are deliberately withheld here so a
    // production root cannot accidentally perform an unrecorded database,
    // cache, outbox, projection, or timer operation.
    const protocolNames = options?.protocolNames ?? deps?.protocolNames ?? {
        ...DEFAULT_TASK_PROTOCOL_NAMES,
        task: name,
    };
    if (protocolNames.task !== name) {
        throw new Error('HATCHET_TASK_PROTOCOL_ROOT_NAME_MISMATCH');
    }
    const rootDeps = deps === undefined && options?.protocolNames === undefined
        ? undefined
        : {
              ...(deps === undefined ? {} : { useTaskStateChildren: true }),
              protocolNames,
          };
    return hatchet.durableTask<TaskTaskInput, TaskTaskOutput>({
        name,
        retries: 0,
        executionTimeout: options?.executionTimeout ?? TASK_EXECUTION_TIMEOUT,
        concurrency: {
            expression: 'input.tenantTaskKey',
            maxRuns: 1,
            limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
        },
        fn: async (input: TaskTaskInput, ctx: DurableContext<TaskTaskInput>) =>
            executeTaskTask(input, ctx, rootDeps),
    });
}

export function createTaskStateTask(
    hatchet: HatchetClient,
    deps: TaskTaskDeps,
    options?: { name?: string }
) {
    const name = options?.name ?? deps.protocolNames?.taskState ?? TASK_STATE_TASK_NAME;
    if (deps.protocolNames !== undefined && name !== deps.protocolNames.taskState) {
        throw new Error('HATCHET_TASK_PROTOCOL_STATE_NAME_MISMATCH');
    }
    return hatchet.task<TaskStateInput, TaskStateOutput>({
        name,
        retries: 3,
        executionTimeout: TASK_EXECUTION_TIMEOUT,
        fn: async (input: TaskStateInput) => executeTaskStateTask(input, deps),
    });
}
