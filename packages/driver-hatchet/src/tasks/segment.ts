import type {
    SegmentResult,
    TurnExecutor,
    TurnWake,
} from '@a2arium/callagent-core/unstable';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { JsonObject, JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import type { HatchetClient } from '../hatchetClient.js';
import { DriverRunsRepository } from '../driverRunsRepository.js';

export const SEGMENT_TASK_NAME = 'aplret.segment';

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
                operation: 'turn.segment',
                status: output.boundary.kind === 'fail' ? 'failed' : 'completed',
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

export function createSegmentTask(hatchet: HatchetClient, deps: SegmentTaskDeps) {
    return hatchet.task<SegmentTaskInput, SegmentTaskOutput>({
        name: SEGMENT_TASK_NAME,
        retries: 3,
        fn: async (input: SegmentTaskInput, ctx: Context<SegmentTaskInput>) =>
            executeSegmentTask(input, ctx, deps),
    });
}
