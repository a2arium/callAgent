import {
    STREAM_ENDED_WITHOUT_TERMINAL_STATUS,
    consumeA2ASseAsChatResult,
    streamA2ASseRuntimeEvents,
} from '../src/internal/invokers/a2aSseChatStream.js';
import type { ChatRoute, ChatSender } from '../src/types.js';

describe('a2aSseChatStream', () => {
    const taskId = 'task-sse-helper';
    const route: ChatRoute = { network: 'web', conversationId: 'c1' };

    test('ignores comments, malformed JSON, and non-A2A frames while consuming valid terminal events', async () => {
        const messages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { messages.push(text); },
        };

        const result = await consumeA2ASseAsChatResult({
            body: sseBody([
                ': keepalive\n\n',
                'event: task.status\ndata: {bad json}\n\n',
                `event: task.status\ndata: ${JSON.stringify({ specversion: '1.0', id: 'not-a2a', time: ts(), data: { nope: true } })}\n\n`,
                frame(cloudEvent('artifact', {
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'hello' }],
                    },
                    final: false,
                })),
                frame(cloudEvent('completed', {
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                })),
            ]),
            taskId,
            route,
            chatSender: sender,
        });

        expect(messages).toEqual(['hello']);
        expect(result).toEqual({ id: taskId, status: 'completed', output: { text: 'hello' } });
    });

    test('supports multi-line data frames split outside JSON strings', async () => {
        const messages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { messages.push(text); },
        };
        const cloud = cloudEvent('multi-line', {
            id: taskId,
            status: {
                state: 'failed',
                message: { role: 'agent', parts: [{ type: 'text', text: 'remote failed' }] },
            },
            final: true,
        });
        const json = JSON.stringify(cloud, null, 2);
        const dataLines = json.split('\n').map((line) => `data: ${line}`).join('\n');

        const result = await consumeA2ASseAsChatResult({
            body: sseBody([`event: task.status\n${dataLines}\n\n`]),
            taskId,
            route,
            chatSender: sender,
        });

        expect(messages).toEqual([]);
        expect(result).toEqual({ id: taskId, status: 'failed', error: 'remote failed' });
    });

    test('returns known failure when stream ends before terminal status', async () => {
        const sender: ChatSender = {
            async sendMessage() { },
        };

        const result = await consumeA2ASseAsChatResult({
            body: sseBody([
                frame(cloudEvent('working', {
                    id: taskId,
                    status: { state: 'working' },
                    final: false,
                })),
            ]),
            taskId,
            route,
            chatSender: sender,
        });

        expect(result).toEqual({ id: taskId, status: 'failed', error: STREAM_ENDED_WITHOUT_TERMINAL_STATUS });
    });

    test('returns input_required with prompt from status message parts', async () => {
        const sender: ChatSender = {
            async sendMessage() { },
        };

        const result = await consumeA2ASseAsChatResult({
            body: sseBody([
                frame(cloudEvent('input-required', {
                    id: taskId,
                    status: {
                        state: 'input-required',
                        metadata: { token: 'tok-sse' },
                        message: { role: 'agent', parts: [{ type: 'text', text: 'Need info?' }] },
                    },
                    final: false,
                })),
            ]),
            taskId,
            route,
            chatSender: sender,
        });

        expect(result).toEqual({ id: taskId, status: 'input_required', token: 'tok-sse', prompt: 'Need info?' });
    });

    test('yields canonical runtime SSE frames and keeps debug frames out of chat projection', async () => {
        const messages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { messages.push(text); },
        };
        const toolStarted = runtimeEvent('tool.started', {
            token: 'tool-1',
            toolName: 'search',
        }, 'debug');
        const completed = runtimeEvent('task.status', {
            state: 'completed',
            terminal: true,
        }, 'public');

        const events = await collectAsync(streamA2ASseRuntimeEvents({
            body: sseBody([
                `event: tool.started\ndata: ${JSON.stringify(toolStarted)}\n\n`,
                `event: task.status\ndata: ${JSON.stringify(completed)}\n\n`,
            ]),
            taskId,
            tenantId: 'tenant-test',
        }));

        expect(events.map((event) => event.type)).toEqual(['tool.started', 'task.status']);

        const result = await consumeA2ASseAsChatResult({
            body: sseBody([
                `event: tool.started\ndata: ${JSON.stringify(toolStarted)}\n\n`,
                `event: task.status\ndata: ${JSON.stringify(completed)}\n\n`,
            ]),
            taskId,
            route,
            chatSender: sender,
        });

        expect(messages).toEqual([]);
        expect(result).toEqual({ id: taskId, status: 'completed', output: { ok: true } });
    });
});

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frameValue of frames) {
                controller.enqueue(encoder.encode(frameValue));
            }
            controller.close();
        },
    });
}

function frame(data: unknown): string {
    return `event: task.status\ndata: ${JSON.stringify(data)}\n\n`;
}

function cloudEvent(id: string, data: unknown): unknown {
    return {
        specversion: '1.0',
        id,
        type: 'task.status',
        source: `/tasks/${taskIdForSource(data)}`,
        time: ts(),
        datacontenttype: 'application/json',
        data,
    };
}

function taskIdForSource(data: unknown): string {
    return typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string'
        ? data.id
        : 'unknown';
}

function ts(): string {
    return '2026-05-02T00:00:00.000Z';
}

function runtimeEvent(type: 'tool.started' | 'task.status', data: unknown, visibility: 'debug' | 'public'): unknown {
    return {
        version: '2026-05-02',
        id: `runtime-${type}`,
        seq: type === 'tool.started' ? 1 : 2,
        taskId: 'task-sse-helper',
        tenantId: 'tenant-test',
        ts: ts(),
        type,
        visibility,
        channel: visibility === 'debug' ? 'debug' : 'user',
        data,
    };
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const values: T[] = [];
    for await (const value of iterable) {
        values.push(value);
    }
    return values;
}
