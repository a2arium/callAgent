import type {
    A2AEvent,
    Artifact,
    TaskStatus,
} from '../shared/types/StreamingEvents.js';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamEvent,
    type RuntimeStreamMessagePart,
} from './runtimeStreamEvents.js';

export type A2AToRuntimeStreamOptions = {
    seq: number;
    id: string;
    ts: string;
    tenantId?: string;
    agentId?: string;
    parentTaskId?: string;
    traceId?: string;
    spanId?: string;
};

function common(event: A2AEvent, options: A2AToRuntimeStreamOptions) {
    return {
        version: RUNTIME_STREAM_EVENT_VERSION,
        id: options.id,
        seq: options.seq,
        taskId: event.id,
        tenantId: options.tenantId,
        agentId: options.agentId,
        parentTaskId: options.parentTaskId,
        traceId: options.traceId,
        spanId: options.spanId,
        ts: options.ts,
    };
}

function isTerminalTaskStatus(status: TaskStatus, final: boolean): boolean {
    if (!final) return false;
    return status.state === 'completed' || status.state === 'failed' || status.state === 'canceled';
}

function messagePartsFromStatus(status: TaskStatus): RuntimeStreamMessagePart[] | undefined {
    return status.message?.parts as RuntimeStreamMessagePart[] | undefined;
}

function artifactParts(artifact: Artifact): RuntimeStreamMessagePart[] {
    return artifact.parts as RuntimeStreamMessagePart[];
}

export function mapA2AEventToRuntimeStream(
    event: A2AEvent,
    options: A2AToRuntimeStreamOptions
): RuntimeStreamEvent[] {
    if ('status' in event) {
        const parts = messagePartsFromStatus(event.status);
        const mapped = RuntimeStreamEventSchema.parse({
            ...common(event, options),
            type: 'task.status',
            visibility: 'public',
            channel: 'user',
            data: {
                state: event.status.state,
                terminal: isTerminalTaskStatus(event.status, event.final),
                ...(parts
                    ? { message: { role: event.status.message?.role ?? 'agent', parts } }
                    : {}),
                ...(event.status.metadata ? { metadata: event.status.metadata } : {}),
            },
        });

        if (event.status.state === 'input-required') {
            const token = typeof event.status.metadata?.token === 'string'
                ? event.status.metadata.token
                : undefined;
            if (!token || !parts) {
                return [mapped];
            }

            const inputRequired = RuntimeStreamEventSchema.parse({
                ...common(event, {
                    ...options,
                    id: `${options.id}:input-required`,
                    seq: options.seq + 1,
                }),
                type: 'input.required',
                visibility: 'public',
                channel: 'user',
                data: {
                    token,
                    parts,
                },
            });
            return [inputRequired, mapped];
        }

        return [mapped];
    }

    const artifact = event.artifact;
    const delta = RuntimeStreamEventSchema.parse({
        ...common(event, options),
        type: 'artifact.delta',
        visibility: 'public',
        channel: 'user',
        data: {
            artifactId: artifact.name ?? `artifact-${artifact.index ?? 0}`,
            ...(artifact.name ? { name: artifact.name } : {}),
            index: artifact.index ?? 0,
            append: artifact.append === true,
            parts: artifactParts(artifact),
        },
    });

    if (artifact.lastChunk === true) {
        const done = RuntimeStreamEventSchema.parse({
            ...common(event, {
                ...options,
                id: `${options.id}:artifact-done`,
                seq: options.seq + 1,
            }),
            type: 'artifact.done',
            visibility: 'public',
            channel: 'user',
            data: {
                artifactId: artifact.name ?? `artifact-${artifact.index ?? 0}`,
                index: artifact.index ?? 0,
            },
        });
        return [delta, done];
    }

    return [delta];
}

