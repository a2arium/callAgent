import type {
    RuntimeWakeEvent,
} from '@a2arium/callagent-core/unstable';
import type { DurableContext } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { Duration } from '@hatchet-dev/typescript-sdk/v1/client/duration.js';
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
import { serializeDriverRunError, type DriverRunsRepository } from '../driverRunsRepository.js';
import { withHatchetTaskLogging } from '../hatchetLogging.js';

export const TASK_TASK_NAME = 'aplret.task';
const BOUNDARY_EVENT_LOOKBACK = '5m';
const TASK_EXECUTION_TIMEOUT = '30m';

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
    driverRuns?: DriverRunsRepository;
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

type AwaitableBoundary = Extract<
    SegmentTaskBoundary,
    { kind: 'await_input' | 'await_tool' | 'await_child' | 'await_event' }
>;
type SegmentEventWake = Exclude<SegmentTaskWake, { trigger: 'start' }>;

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
    let wake: SegmentTaskWake = { trigger: 'start', input: input.input };
    let idempotencyKey = input.idempotencyKey;
    let turnSeq = 0;

    try {
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

            if (isTerminalBoundary(segment.boundary)) {
                await finalizeRootRun(input, segment, deps);
                await notifyPersistedA2AParentIfTerminal(input, segment, deps);
                return segment;
            }

            if (
                segment.boundary.kind === 'await_input' ||
                segment.boundary.kind === 'await_tool' ||
                segment.boundary.kind === 'await_child' ||
                segment.boundary.kind === 'await_event'
            ) {
                const event =
                    await findPersistedBoundaryEvent(input, segment.boundary, deps)
                    ?? await waitForBoundaryEvent(ctx, input, segment.boundary);
                wake = boundaryEventToWake(segment.boundary, event);
                idempotencyKey = event.idempotencyKey ?? `${input.taskId}:${event.kind}:${event.token}`;
                continue;
            }

            return segment;
        }
    } catch (error) {
        await finalizeRootRunAsFailed(input, deps, error);
        throw error;
    }
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

async function notifyPersistedA2AParentIfTerminal(
    input: TaskTaskInput,
    segment: SegmentTaskOutput,
    deps?: TaskTaskDeps
): Promise<void> {
    if (deps?.events === undefined || deps.prisma?.wMSession === undefined) {
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
            output: outputFromTerminalBoundary(segment.boundary),
        },
        { key: `${parentTenantId}:${parentTaskId}:${parentChildToken}` }
    );
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
    const eventKind =
        boundary.kind === 'await_input'
            ? 'input'
            : boundary.kind === 'await_tool'
              ? 'tool'
              : boundary.kind === 'await_child'
                ? 'child'
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

async function findPersistedBoundaryEvent(
    input: TaskTaskInput,
    boundary: AwaitableBoundary,
    deps?: TaskTaskDeps
): Promise<(RuntimeWakeEvent & { idempotencyKey?: string }) | undefined> {
    if (boundary.kind !== 'await_child' || deps?.prisma?.wMEvent === undefined) {
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
            output: {
                ok: false,
                error: payload.error,
            },
            idempotencyKey: `${input.taskId}:child:${boundary.token}`,
        };
    }

    return {
        kind: 'child',
        token: boundary.token,
        childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : boundary.token,
        output: 'resultPreview' in payload ? payload.resultPreview : payload.result,
        idempotencyKey: `${input.taskId}:child:${boundary.token}`,
    };
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
        return {
            kind: 'child',
            token,
            childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : token,
            output: 'output' in payload ? payload.output : payload.result,
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

function boundaryEventToWake(
    boundary: AwaitableBoundary,
    event: RuntimeWakeEvent
): SegmentTaskWake {
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
    options?: { executionTimeout?: Duration }
) {
    return hatchet.durableTask<TaskTaskInput, TaskTaskOutput>({
        name,
        retries: 0,
        executionTimeout: options?.executionTimeout ?? TASK_EXECUTION_TIMEOUT,
        fn: async (input: TaskTaskInput, ctx: DurableContext<TaskTaskInput>) =>
            executeTaskTask(input, ctx, deps),
    });
}
