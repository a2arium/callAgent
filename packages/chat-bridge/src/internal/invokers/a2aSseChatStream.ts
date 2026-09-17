import {
    mapA2AEventToRuntimeStream,
    projectRuntimeStreamChat,
    RuntimeStreamEventSchema,
    type A2AEvent,
    type RuntimeStreamEvent,
} from '@a2arium/callagent-core';
import type { ChatRoute, ChatSender, ResultPayload } from '../../types.js';
import {
    createStreamForwardState,
    forwardChatProjectionEvent,
} from './chatProjectionForwarder.js';

type SseMessage = {
    id?: string;
    event?: string;
    data?: string;
};

type A2ACloudEvent = {
    id?: string;
    time?: string;
    data?: unknown;
};

export const STREAM_ENDED_WITHOUT_TERMINAL_STATUS = 'Streaming response ended before terminal task status';

export async function consumeA2ASseAsChatResult(params: {
    body: ReadableStream<Uint8Array>;
    taskId: string;
    tenantId?: string;
    route: ChatRoute;
    chatSender: ChatSender;
}): Promise<ResultPayload> {
    const state = createStreamForwardState();
    for await (const runtimeEvents of streamA2ASseRuntimeEventBatches(params)) {
        const chatEvents = projectRuntimeStreamChat(runtimeEvents);
        for (const event of chatEvents) {
            const result = await forwardChatProjectionEvent({
                sender: params.chatSender,
                route: params.route,
                state,
                event,
            });
            if (result.kind === 'input_required') {
                return { id: params.taskId, status: 'input_required', token: result.token, prompt: result.prompt };
            }
            if (result.kind === 'failed') {
                return { id: params.taskId, status: 'failed', error: result.error };
            }
            if (result.kind === 'completed') {
                return { id: params.taskId, status: 'completed', output: result.output };
            }
        }
    }

    return { id: params.taskId, status: 'failed', error: STREAM_ENDED_WITHOUT_TERMINAL_STATUS };
}

export async function* streamA2ASseRuntimeEvents(params: {
    body: ReadableStream<Uint8Array>;
    taskId: string;
    tenantId?: string;
}): AsyncIterable<RuntimeStreamEvent> {
    for await (const events of streamA2ASseRuntimeEventBatches(params)) {
        for (const event of events) {
            yield event;
        }
    }
}

async function* streamA2ASseRuntimeEventBatches(params: {
    body: ReadableStream<Uint8Array>;
    taskId: string;
    tenantId?: string;
}): AsyncIterable<RuntimeStreamEvent[]> {
    for await (const message of readSseMessages(params.body)) {
        if (!message.data) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(message.data) as unknown;
        } catch {
            continue;
        }

        const directRuntimeEvent = RuntimeStreamEventSchema.safeParse(parsed);
        if (directRuntimeEvent.success) {
            yield [directRuntimeEvent.data];
            continue;
        }

        if (!parsed || typeof parsed !== 'object') continue;

        const cloudEvent = parsed as A2ACloudEvent;
        if (!cloudEvent.data) continue;

        const runtimeEvent = RuntimeStreamEventSchema.safeParse(cloudEvent.data);
        if (runtimeEvent.success) {
            yield [runtimeEvent.data];
            continue;
        }

        try {
            yield mapA2AEventToRuntimeStream(cloudEvent.data as A2AEvent, {
                id: cloudEvent.id ?? message.id ?? `${params.taskId}:remote`,
                seq: 0,
                ts: cloudEvent.time ?? new Date().toISOString(),
                tenantId: params.tenantId,
            });
        } catch {
            continue;
        }
    }
}

async function* readSseMessages(body: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const message = parseSseMessage(raw);
                if (message) {
                    yield message;
                }
                boundary = buffer.indexOf('\n\n');
            }
        }

        buffer += decoder.decode();
        const message = parseSseMessage(buffer);
        if (message) {
            yield message;
        }
    } finally {
        reader.releaseLock();
    }
}

function parseSseMessage(raw: string): SseMessage | undefined {
    const message: SseMessage = {};
    const data: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

        if (field === 'id') {
            message.id = value;
        } else if (field === 'event') {
            message.event = value;
        } else if (field === 'data') {
            data.push(value);
        }
    }

    if (data.length > 0) {
        message.data = data.join('\n');
    }

    return message.id || message.event || message.data ? message : undefined;
}
