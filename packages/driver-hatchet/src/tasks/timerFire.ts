import {
    RuntimeTimerRepository,
    timerRecordToWake,
    type RuntimeTimerRecord,
} from '@a2arium/callagent-core/unstable';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { Duration } from '@hatchet-dev/typescript-sdk/v1/client/duration.js';
import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1/types.js';
import type { HatchetClient } from '../hatchetClient.js';
import { DriverRunsRepository, serializeDriverRunError } from '../driverRunsRepository.js';
import { withHatchetTaskLogging } from '../hatchetLogging.js';

export const TIMER_FIRE_TASK_NAME = 'aplret.timer.fire';
const TIMER_FIRE_EXECUTION_TIMEOUT = '5m';
const DEFAULT_TIMER_FIRE_LEASE_TTL_MS = 5 * 60 * 1000;

export type TimerFireTaskInput = JsonObject & {
    tenantId: string;
    taskId: string;
    agentId?: string;
    token: string;
    timerId: string;
    idempotencyKey: string;
};

export type TimerFireTaskOutput = JsonObject & {
    status: 'fired' | 'noop' | 'failed';
    reason?: string;
};

export type TimerFireDeps = {
    runtimeTimers: RuntimeTimerRepository;
    onTaskRunTimeout?: (params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        token: string;
        dueAt: string;
        payload?: unknown;
    }) => Promise<void>;
    driverRuns?: DriverRunsRepository;
    events?: {
        push: (
            eventKey: string,
            payload: Record<string, unknown>,
            options?: { key?: string }
        ) => Promise<unknown>;
    };
    leaseTtlMs?: number;
};

export async function executeTimerFireTask(
    input: TimerFireTaskInput,
    ctx: Context<TimerFireTaskInput>,
    deps: TimerFireDeps
): Promise<TimerFireTaskOutput> {
    return withHatchetTaskLogging(input, ctx, 'timer.fire', () =>
        executeTimerFireTaskInner(input, ctx, deps)
    );
}

async function executeTimerFireTaskInner(
    input: TimerFireTaskInput,
    ctx: Context<TimerFireTaskInput>,
    deps: TimerFireDeps
): Promise<TimerFireTaskOutput> {
    await deps.driverRuns?.upsertByProviderRunId({
        providerRunId: ctx.workflowRunId(),
        providerTaskRunId: ctx.taskRunExternalId(),
        tenantId: input.tenantId,
        taskId: input.taskId,
        agentId: input.agentId ?? null,
        token: input.token,
        idempotencyKey: input.idempotencyKey,
        rootTaskId: input.taskId,
        operation: 'timer.fire',
        status: 'running',
        boundaryKind: 'timer',
    });

    const lease = await deps.runtimeTimers.acquireFireLease({
        tenantId: input.tenantId,
        taskId: input.taskId,
        token: input.token,
        timerId: input.timerId,
        leaseTtlMs: deps.leaseTtlMs ?? DEFAULT_TIMER_FIRE_LEASE_TTL_MS,
    });

    if (lease === null) {
        await deps.driverRuns?.upsertByProviderRunId({
            providerRunId: ctx.workflowRunId(),
            providerTaskRunId: ctx.taskRunExternalId(),
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId ?? null,
            token: input.token,
            idempotencyKey: input.idempotencyKey,
            rootTaskId: input.taskId,
            operation: 'timer.fire',
            status: 'completed',
            boundaryKind: 'timer',
        });
        return { status: 'noop', reason: 'TIMER_NOT_DUE_OR_ALREADY_CLOSED' };
    }

    try {
        const firedAt = new Date();
        if (lease.timer.kind === 'task_run_timeout') {
            if (deps.onTaskRunTimeout === undefined) {
                throw new Error('TASK_RUN_TIMEOUT_HANDLER_MISSING');
            }
            await deps.onTaskRunTimeout({
                tenantId: input.tenantId,
                taskId: input.taskId,
                ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
                token: input.token,
                dueAt: lease.timer.dueAt.toISOString(),
                ...(lease.timer.payload !== null && lease.timer.payload !== undefined
                    ? { payload: lease.timer.payload }
                    : {}),
            });
        } else {
            if (deps.events === undefined) {
                throw new Error('TIMER_EVENT_PUSHER_MISSING');
            }
            const wake = timerRecordToWake(lease.timer, firedAt);
            await deps.events.push(
                `aplret.timer.${input.token}`,
                {
                    tenantId: input.tenantId,
                    taskId: input.taskId,
                    agentId: input.agentId,
                    idempotencyKey: input.idempotencyKey,
                    ...wake,
                },
                { key: `${input.tenantId}:${input.taskId}:timer:${input.timerId}` }
            );
        }
        await deps.runtimeTimers.markFired({
            id: lease.timer.id,
            fireLeaseId: lease.fireLeaseId,
            firedAt,
        });
        await deps.driverRuns?.upsertByProviderRunId({
            providerRunId: ctx.workflowRunId(),
            providerTaskRunId: ctx.taskRunExternalId(),
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId ?? null,
            token: input.token,
            idempotencyKey: input.idempotencyKey,
            rootTaskId: rootTaskId(lease.timer),
            operation: 'timer.fire',
            status: 'completed',
            boundaryKind: 'timer',
        });
        return { status: 'fired' };
    } catch (error) {
        await deps.runtimeTimers.markFailed({
            id: lease.timer.id,
            fireLeaseId: lease.fireLeaseId,
            error: serializeDriverRunError(error),
        });
        await deps.driverRuns?.upsertByProviderRunId({
            providerRunId: ctx.workflowRunId(),
            providerTaskRunId: ctx.taskRunExternalId(),
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId ?? null,
            token: input.token,
            idempotencyKey: input.idempotencyKey,
            rootTaskId: rootTaskId(lease.timer),
            operation: 'timer.fire',
            status: 'failed',
            boundaryKind: 'timer',
            error: serializeDriverRunError(error),
        });
        throw error;
    }
}

function rootTaskId(timer: RuntimeTimerRecord): string {
    return timer.rootTaskId ?? timer.taskId;
}

export function createTimerFireTask(
    hatchet: HatchetClient,
    deps: TimerFireDeps,
    options?: { executionTimeout?: Duration }
) {
    return hatchet.task<TimerFireTaskInput, TimerFireTaskOutput>({
        name: TIMER_FIRE_TASK_NAME,
        retries: 3,
        executionTimeout: options?.executionTimeout ?? TIMER_FIRE_EXECUTION_TIMEOUT,
        fn: async (input: TimerFireTaskInput, ctx: Context<TimerFireTaskInput>) =>
            executeTimerFireTask(input, ctx, deps),
    });
}
