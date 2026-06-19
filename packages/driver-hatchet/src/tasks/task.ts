import type {
    RuntimeWakeEvent,
} from '@a2arium/callagent-core/unstable';
import type { DurableContext } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { JsonObject, JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import type { HatchetClient } from '../hatchetClient.js';
import {
    SEGMENT_TASK_NAME,
    type SegmentTaskBoundary,
    type SegmentTaskInput,
    type SegmentTaskOutput,
    type SegmentTaskWake,
} from './segment.js';
import type {
    OutboxDispatchInput,
    OutboxDispatchOutput,
} from './outboxDispatch.js';
import { OUTBOX_DISPATCH_TASK_NAME } from './outboxDispatch.js';

export const TASK_TASK_NAME = 'aplret.task';

export function agentTaskName(agentId: string): string {
    return `agent.${agentId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export type TaskTaskInput = JsonObject & {
    tenantId: string;
    taskId: string;
    agentId?: string;
    input: JsonValue;
    idempotencyKey: string;
};

export type TaskTaskOutput = SegmentTaskOutput;

export type TaskTaskDeps = {
    prisma?: {
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
    };
};

type AwaitableBoundary = Extract<
    SegmentTaskBoundary,
    { kind: 'await_input' | 'await_tool' }
>;
type SegmentEventWake = Exclude<SegmentTaskWake, { trigger: 'start' }>;

export async function executeTaskTask(
    input: TaskTaskInput,
    ctx: DurableContext<TaskTaskInput>,
    deps?: TaskTaskDeps
): Promise<TaskTaskOutput> {
    let wake: SegmentTaskWake = { trigger: 'start', input: input.input };
    let idempotencyKey = input.idempotencyKey;
    let turnSeq = 0;

    for (;;) {
        turnSeq += 1;
        const segmentInput: SegmentTaskInput = {
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId,
            wake,
            idempotencyKey,
            turnSeq,
        };
        const segmentRaw = await ctx.runChild<SegmentTaskInput, SegmentTaskOutput>(
            SEGMENT_TASK_NAME,
            segmentInput,
            {
                key: idempotencyKey,
                additionalMetadata: buildTaskRunMetadata(input, segmentInput),
            }
        );
        const segment = normalizeSegmentOutput(segmentRaw);
        await dispatchPendingOutboxChildren(ctx, input, segment, deps);

        if (segment.boundary.kind === 'complete' || segment.boundary.kind === 'fail') {
            return segment;
        }

        if (segment.boundary.kind === 'await_input' || segment.boundary.kind === 'await_tool') {
            const event = await waitForBoundaryEvent(ctx, input, segment.boundary);
            wake = boundaryEventToWake(segment.boundary, event);
            idempotencyKey = event.idempotencyKey ?? `${input.taskId}:${event.kind}:${event.token}`;
            continue;
        }

        return segment;
    }
}

async function dispatchPendingOutboxChildren(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    if (deps?.prisma === undefined) {
        return;
    }
    const rows = await deps.prisma.outbox.findMany({
        where: {
            tenantId: input.tenantId,
            key: input.taskId,
            topic: { in: ['task.status', 'task.input_required', 'task.child_dispatch'] },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });

    await Promise.all(
        rows.map((row) => {
            const payload = jsonObjectOrEmpty(row.payload);
            const token = typeof payload.token === 'string' ? payload.token : undefined;
            const traceId = typeof payload.traceId === 'string' ? payload.traceId : undefined;
            const agentId =
                typeof payload.agentId === 'string'
                    ? payload.agentId
                    : segment.agentId ?? input.agentId;
            const childInput: OutboxDispatchInput = {
                outboxRowId: row.id,
                eventType: row.topic,
                tenantId: row.tenantId,
                taskId: row.key,
                ...(agentId !== undefined ? { agentId } : {}),
                ...(traceId !== undefined ? { traceId } : {}),
                ...(token !== undefined ? { token } : {}),
            };
            return ctx.runNoWaitChild<OutboxDispatchInput, OutboxDispatchOutput>(
                OUTBOX_DISPATCH_TASK_NAME,
                childInput,
                {
                    key: row.id,
                    additionalMetadata: {
                        operation: 'effect.outbox.dispatch',
                        tenantId: row.tenantId,
                        taskId: row.key,
                        rootTaskId: input.taskId,
                        tenantTaskKey: `${row.tenantId}:${row.key}`,
                        outboxRowId: row.id,
                        eventType: row.topic,
                        ...(agentId !== undefined ? { agentId } : {}),
                        ...(traceId !== undefined ? { traceId } : {}),
                        ...(token !== undefined ? { token } : {}),
                    },
                }
            );
        })
    );
}

function jsonObjectOrEmpty(value: JsonValue): JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

function normalizeSegmentOutput(output: unknown): SegmentTaskOutput {
    if (isSegmentTaskOutput(output)) {
        return output;
    }
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        const wrapped = (output as Record<string, unknown>)[SEGMENT_TASK_NAME];
        if (isSegmentTaskOutput(wrapped)) {
            return wrapped;
        }
    }
    throw new Error('SEGMENT_OUTPUT_INVALID');
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
        rootTaskId: input.taskId,
        tenantTaskKey: `${input.tenantId}:${input.taskId}`,
        idempotencyKey: segmentInput.idempotencyKey,
        turnSeq: String(segmentInput.turnSeq ?? ''),
    };
    if (input.agentId !== undefined) {
        metadata.agentId = input.agentId;
    }
    return metadata;
}

async function waitForBoundaryEvent(
    ctx: DurableContext<TaskTaskInput>,
    input: TaskTaskInput,
    boundary: AwaitableBoundary
): Promise<RuntimeWakeEvent & { idempotencyKey?: string }> {
    const eventKind = boundary.kind === 'await_input' ? 'input' : 'tool';
    const payload = await ctx.waitForEvent(
        `aplret.${eventKind}.${boundary.token}`,
        `input.tenantId == "${input.tenantId}" && input.taskId == "${input.taskId}"`,
        undefined,
        undefined,
        undefined,
        `wait:${eventKind}:${boundary.token}`
    );
    return normalizeWakeEvent(eventKind, boundary.token, payload);
}

function normalizeWakeEvent(
    eventKind: 'input' | 'tool',
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

    return {
        kind: 'tool',
        token,
        result: payload.result,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
}

function boundaryEventToWake(
    boundary: AwaitableBoundary,
    event: RuntimeWakeEvent
): SegmentTaskWake {
    return boundary.kind === 'await_input'
        ? { trigger: 'resume', event: event as SegmentEventWake['event'] }
        : { trigger: 'tool', event: event as SegmentEventWake['event'] };
}

export function createTaskTask(
    hatchet: HatchetClient,
    deps?: TaskTaskDeps,
    name: string = TASK_TASK_NAME
) {
    return hatchet.durableTask<TaskTaskInput, TaskTaskOutput>({
        name,
        retries: 0,
        fn: async (input: TaskTaskInput, ctx: DurableContext<TaskTaskInput>) =>
            executeTaskTask(input, ctx, deps),
    });
}
