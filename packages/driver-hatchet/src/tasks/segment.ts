import type {
    SegmentResult,
    TurnExecutor,
    TurnWake,
} from '@a2arium/callagent-core/unstable';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { Duration } from '@hatchet-dev/typescript-sdk/v1/client/duration.js';
import type { JsonObject, JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import type { HatchetClient } from '../hatchetClient.js';
import { DriverRunsRepository, serializeDriverRunError } from '../driverRunsRepository.js';
import { withHatchetTaskLogging } from '../hatchetLogging.js';

export const SEGMENT_TASK_NAME = 'aplret.segment';
const SEGMENT_EXECUTION_TIMEOUT = '30m';

export type SegmentTaskWake =
    | { trigger: 'start'; input: JsonValue }
    | { trigger: 'resume'; event: SegmentWakeEvent }
    | { trigger: 'tool'; event: SegmentWakeEvent }
    | { trigger: 'child'; event: SegmentWakeEvent }
    | { trigger: 'timer'; event: SegmentWakeEvent }
    | { trigger: 'event'; event: SegmentWakeEvent }
    | { trigger: 'conversation'; event: SegmentWakeEvent };

export type SegmentWakeEvent =
    | { kind: 'input'; token: string; value: JsonValue }
    | { kind: 'tool'; token: string; result: JsonValue }
    | { kind: 'child'; token: string; childTaskId: string; output: JsonValue }
    | { kind: 'timer'; token: string; timerId: string; payload?: JsonValue }
    | { kind: 'external'; token: string; type: string; data: JsonValue }
    | { kind: 'conversation'; token: string; messageId: string; data: JsonValue };

export type SegmentTaskInput = JsonObject & {
    tenantId: string;
    taskId: string;
    agentId?: string;
    wake: SegmentTaskWake;
    idempotencyKey: string;
    turnSeq?: number;
};

export type SegmentTaskBoundary =
    | { kind: 'await_input'; token: string; expiresAt?: string }
    | { kind: 'await_tool'; token: string }
    | { kind: 'await_child'; token: string }
    | { kind: 'await_event'; token: string }
    | { kind: 'sleep'; token: string; fireAt: string }
    | { kind: 'paused'; reason: string }
    | { kind: 'complete'; result?: JsonValue }
    | { kind: 'fail'; error: JsonValue };

export type SegmentTaskOutput = JsonObject & {
    tenantId: string;
    taskId: string;
    agentId?: string;
    boundary: SegmentTaskBoundary;
    taskStatus: SegmentResult['taskStatus'];
    traceId?: string;
    turnTraceId?: string;
};

export type SegmentTaskDeps = {
    turnExecutor: TurnExecutor;
    driverRuns?: DriverRunsRepository;
};

function segmentDriverRunFields(input: SegmentTaskInput) {
    return {
        tenantId: input.tenantId,
        taskId: input.taskId,
        agentId: input.agentId ?? null,
        idempotencyKey: input.idempotencyKey,
        rootTaskId: input.taskId,
        turnSeq: input.turnSeq ?? null,
        token:
            input.wake.trigger === 'start'
                ? null
                : 'token' in input.wake.event
                  ? input.wake.event.token
                  : null,
    };
}

export async function executeSegmentTask(
    input: SegmentTaskInput,
    ctx: Context<SegmentTaskInput>,
    deps: SegmentTaskDeps
): Promise<SegmentTaskOutput> {
    return withHatchetTaskLogging(input, ctx, 'turn.segment', () =>
        executeSegmentTaskInner(input, ctx, deps)
    );
}

async function executeSegmentTaskInner(
    input: SegmentTaskInput,
    ctx: Context<SegmentTaskInput>,
    deps: SegmentTaskDeps
): Promise<SegmentTaskOutput> {
    const fields = segmentDriverRunFields(input);
    if (deps.driverRuns) {
        await deps.driverRuns.upsertByProviderRunId({
            providerRunId: ctx.workflowRunId(),
            providerTaskRunId: ctx.taskRunExternalId(),
            tenantId: fields.tenantId,
            taskId: fields.taskId,
            agentId: fields.agentId,
            token: fields.token,
            idempotencyKey: fields.idempotencyKey,
            rootTaskId: fields.rootTaskId,
            turnSeq: fields.turnSeq,
            operation: 'turn.segment',
            status: 'running',
        });
    }

    try {
        const result = await deps.turnExecutor.runSegment({
            ...input,
            wake: input.wake as TurnWake,
        });
        const output = toSegmentTaskOutput(result);
        if (deps.driverRuns) {
            await deps.driverRuns.upsertByProviderRunId({
                providerRunId: ctx.workflowRunId(),
                providerTaskRunId: ctx.taskRunExternalId(),
                tenantId: fields.tenantId,
                taskId: fields.taskId,
                agentId: output.agentId ?? fields.agentId,
                traceId: output.traceId ?? null,
                token: fields.token,
                idempotencyKey: fields.idempotencyKey,
                rootTaskId: fields.rootTaskId,
                turnSeq: fields.turnSeq,
                boundaryKind: output.boundary.kind,
                turnTraceId: output.turnTraceId ?? null,
                error: isFailedBoundary(output.boundary)
                    ? errorFromBoundary(output.boundary)
                    : null,
                operation: 'turn.segment',
                status: isFailedBoundary(output.boundary) ? 'failed' : 'completed',
            });
        }
        return output;
    } catch (error) {
        if (deps.driverRuns) {
            await deps.driverRuns.upsertByProviderRunId({
                providerRunId: ctx.workflowRunId(),
                providerTaskRunId: ctx.taskRunExternalId(),
                tenantId: fields.tenantId,
                taskId: fields.taskId,
                agentId: fields.agentId,
                token: fields.token,
                idempotencyKey: fields.idempotencyKey,
                rootTaskId: fields.rootTaskId,
                turnSeq: fields.turnSeq,
                boundaryKind: 'fail',
                error: serializeDriverRunError(error),
                operation: 'turn.segment',
                status: 'failed',
            });
        }
        throw error;
    }
}

function toSegmentTaskOutput(result: SegmentResult): SegmentTaskOutput {
    return {
        tenantId: result.tenantId,
        taskId: result.taskId,
        ...(result.agentId !== undefined ? { agentId: result.agentId } : {}),
        boundary: toSegmentTaskBoundary(result.boundary),
        taskStatus: result.taskStatus,
        ...(result.traceId !== undefined ? { traceId: result.traceId } : {}),
        ...(result.turnTraceId !== undefined ? { turnTraceId: result.turnTraceId } : {}),
    };
}

function toSegmentTaskBoundary(boundary: SegmentResult['boundary']): SegmentTaskBoundary {
    if (boundary.kind === 'complete') {
        return boundary.result !== undefined
            ? { kind: 'complete', result: boundary.result as JsonValue }
            : { kind: 'complete' };
    }
    if (boundary.kind === 'fail') {
        return { kind: 'fail', error: boundary.error as JsonValue };
    }
    return boundary;
}

function isFailedBoundary(boundary: SegmentTaskBoundary): boolean {
    if (boundary.kind === 'fail') {
        return true;
    }
    if (boundary.kind !== 'complete') {
        return false;
    }
    return hasOkFalse(boundary.result);
}

function hasOkFalse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (value as Record<string, unknown>).ok === false;
}

function errorFromBoundary(boundary: SegmentTaskBoundary) {
    if (boundary.kind === 'fail') {
        return serializeDriverRunError(boundary.error);
    }
    if (boundary.kind === 'complete' && hasOkFalse(boundary.result)) {
        return boundary.result as unknown as ReturnType<typeof serializeDriverRunError>;
    }
    return null;
}

export function createSegmentTask(
    hatchet: HatchetClient,
    deps: SegmentTaskDeps,
    options?: { executionTimeout?: Duration }
) {
    return hatchet.task<SegmentTaskInput, SegmentTaskOutput>({
        name: SEGMENT_TASK_NAME,
        retries: 3,
        executionTimeout: options?.executionTimeout ?? SEGMENT_EXECUTION_TIMEOUT,
        fn: async (input: SegmentTaskInput, ctx: Context<SegmentTaskInput>) =>
            executeSegmentTask(input, ctx, deps),
    });
}
