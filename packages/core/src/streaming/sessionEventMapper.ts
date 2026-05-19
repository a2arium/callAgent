import { z } from 'zod';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamEvent,
} from './runtimeStreamEvents.js';

export const WorkingMemoryRuntimeStreamEventSchema = z.object({
    eventId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
}).strict();

export type WorkingMemoryRuntimeStreamEvent = z.infer<typeof WorkingMemoryRuntimeStreamEventSchema>;

export type WorkingMemoryToRuntimeStreamOptions = {
    taskId: string;
    tenantId?: string;
    agentId?: string;
    parentTaskId?: string;
    traceId?: string;
    spanId?: string;
};

function base(event: WorkingMemoryRuntimeStreamEvent, options: WorkingMemoryToRuntimeStreamOptions) {
    return {
        version: RUNTIME_STREAM_EVENT_VERSION,
        id: event.eventId,
        seq: event.seq,
        taskId: options.taskId,
        tenantId: options.tenantId,
        agentId: options.agentId,
        parentTaskId: options.parentTaskId,
        traceId: options.traceId,
        spanId: options.spanId,
        ts: event.createdAt,
    };
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorFromPayload(payload: Record<string, unknown>): { code?: string; message: string } | undefined {
    const error = payload.error;
    if (typeof error === 'string' && error.length > 0) {
        return { message: error };
    }
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        const message = typeof record.message === 'string' ? record.message : undefined;
        if (!message) return undefined;
        const code = typeof record.code === 'string' ? record.code : undefined;
        return code ? { code, message } : { message };
    }
    return undefined;
}

export function mapWorkingMemoryEventToRuntimeStream(
    candidate: WorkingMemoryRuntimeStreamEvent,
    options: WorkingMemoryToRuntimeStreamOptions
): RuntimeStreamEvent[] {
    const event = WorkingMemoryRuntimeStreamEventSchema.parse(candidate);

    if (event.type === 'task.tool_requested') {
        const token = stringField(event.payload, 'token');
        const toolName = stringField(event.payload, 'toolName');
        if (!token || !toolName) return [];

        return [RuntimeStreamEventSchema.parse({
            ...base(event, options),
            type: 'tool.started',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token,
                toolName,
                ...(Object.prototype.hasOwnProperty.call(event.payload, 'argsPreview')
                    ? { argsPreview: event.payload.argsPreview }
                    : {}),
            },
        })];
    }

    if (event.type === 'task.tool_completed') {
        const token = stringField(event.payload, 'token');
        const toolName = stringField(event.payload, 'toolName') ?? stringField(event.payload, 'tool');
        if (!token || !toolName) return [];

        const error = errorFromPayload(event.payload);
        const status = event.payload.status === 'failed' || error ? 'failed' : 'completed';
        return [RuntimeStreamEventSchema.parse({
            ...base(event, options),
            type: 'tool.completed',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token,
                toolName,
                status,
                ...(Object.prototype.hasOwnProperty.call(event.payload, 'resultPreview')
                    ? { resultPreview: event.payload.resultPreview }
                    : {}),
                ...(error ? { error } : {}),
            },
        })];
    }

    if (event.type === 'task.child_started') {
        const token = stringField(event.payload, 'token');
        const agentId = stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId');
        if (!token || !agentId) return [];

        const childTaskId = stringField(event.payload, 'childTaskId');
        return [RuntimeStreamEventSchema.parse({
            ...base(event, options),
            type: 'child.started',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token,
                agentId,
                ...(childTaskId ? { childTaskId } : {}),
            },
        })];
    }

    if (event.type === 'task.child_input_required') {
        const token = stringField(event.payload, 'token');
        const agentId = stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId') ?? 'unknown';
        if (!token) return [];

        const childTaskId = stringField(event.payload, 'childTaskId');
        const prompt = stringField(event.payload, 'prompt') ?? '';
        return [RuntimeStreamEventSchema.parse({
            ...base(event, options),
            type: 'child.message',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token,
                agentId,
                ...(childTaskId ? { childTaskId } : {}),
                parts: [{ type: 'text', text: prompt }],
            },
        })];
    }

    if (event.type === 'task.child_completed' || event.type === 'task.child_failed') {
        const token = stringField(event.payload, 'token');
        const agentId = stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId') ?? 'unknown';
        if (!token) return [];

        const childTaskId = stringField(event.payload, 'childTaskId');
        const error = errorFromPayload(event.payload);
        const status = event.type === 'task.child_failed' || error ? 'failed' : 'completed';
        return [RuntimeStreamEventSchema.parse({
            ...base(event, options),
            type: 'child.completed',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token,
                agentId,
                ...(childTaskId ? { childTaskId } : {}),
                status,
                ...(Object.prototype.hasOwnProperty.call(event.payload, 'resultPreview')
                    ? { resultPreview: event.payload.resultPreview }
                    : {}),
                ...(error ? { error } : {}),
            },
        })];
    }

    return [];
}
