import { jest } from '@jest/globals';
import { JsonRpcInvoker } from '../src/clients/jsonRpcInvoker.js';
import type { ChatSender } from '../src/types.js';

describe('JsonRpcInvoker', () => {
    const endpoint = 'https://api.example.com/rpc';
    const invoker = new JsonRpcInvoker({ endpoint, headers: { Authorization: 'Bearer test' } });

    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('sends start() request and returns result payload', async () => {
        const fetchMock = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            json: async () => ({ jsonrpc: '2.0', result: { id: 't1', status: 'ok', data: { a: 1 } } })
        } as any);

        const res = await invoker.start({
            id: 't1',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' } as any,
            input: { text: 'hi' } as any
        });

        expect(res).toMatchObject({ id: 't1', status: 'ok' });
        expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ Authorization: 'Bearer test', 'Content-Type': 'application/json' })
        }));
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as any).body);
        expect(body).toMatchObject({ method: 'tasks/send', params: { id: 't1', input: { text: 'hi' } } });
    });

    it('maps JSON-RPC error to failed payload in resume()', async () => {
        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            json: async () => ({ jsonrpc: '2.0', error: { code: -1, message: 'boom' }, id: 't2' })
        } as any);

        const res = await invoker.resume({
            id: 't2',
            token: 'tok',
            route: { network: 'web', conversationId: 'c1' } as any,
            input: { text: 'reply' } as any
        });

        expect(res).toEqual({ id: 't2', status: 'failed', error: 'boom' });
    });

    it('streams start() over tasks/sendSubscribe and forwards SSE chunks to chat', async () => {
        const sentMessages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { sentMessages.push(text); },
        };
        const streamingInvoker = new JsonRpcInvoker({
            endpoint,
            headers: { Authorization: 'Bearer test' },
            streaming: true,
            chatSender: sender,
        });

        const fetchMock = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseBody([
                cloudEvent('sse-1', {
                    id: 't-stream',
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello ' }],
                    },
                    final: true,
                }),
                cloudEvent('sse-2', {
                    id: 't-stream',
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'world' }],
                    },
                    final: false,
                }),
                cloudEvent('sse-3', {
                    id: 't-stream',
                    status: { state: 'completed' },
                    final: true,
                }),
            ]),
        } as any);

        await expect(streamingInvoker.start({
            id: 't-stream',
            agentId: 'agent',
            tenantId: 'web',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'hi' },
        })).resolves.toEqual({
            id: 't-stream',
            status: 'completed',
            output: { text: 'hello world' },
        });

        expect(sentMessages).toEqual(['hello ', 'world']);
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as any).body);
        expect(body).toMatchObject({
            method: 'tasks/sendSubscribe',
            params: { id: 't-stream', tenantId: 'web' },
        });
        expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
            headers: expect.objectContaining({ Accept: 'text/event-stream' }),
        }));
    });

    it('startStream yields canonical runtime events from SSE', async () => {
        const streamingInvoker = new JsonRpcInvoker({ endpoint });
        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseBody([
                cloudEvent('stream-method-1', {
                    id: 't-start-stream',
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello' }],
                    },
                    final: true,
                }),
                cloudEvent('stream-method-2', {
                    id: 't-start-stream',
                    status: { state: 'completed' },
                    final: true,
                }),
            ]),
        } as any);

        const events = await collectAsync(streamingInvoker.startStream({
            id: 't-start-stream',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'hi' },
        }));

        expect(events.map((event) => event.type)).toEqual(['artifact.delta', 'artifact.done', 'task.status']);
        expect(events[2]).toMatchObject({ type: 'task.status', data: { state: 'completed', terminal: true } });
    });

    it('start with sink receives canonical runtime events and returns final result', async () => {
        const streamingInvoker = new JsonRpcInvoker({ endpoint });
        const sinkEvents: string[] = [];
        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseBody([
                cloudEvent('sink-method-1', {
                    id: 't-sink',
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello' }],
                    },
                    final: true,
                }),
                cloudEvent('sink-method-2', {
                    id: 't-sink',
                    status: { state: 'completed' },
                    final: true,
                }),
            ]),
        } as any);

        const result = await streamingInvoker.start({
            id: 't-sink',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'hi' },
        }, async (event) => {
            sinkEvents.push(event.type);
        });

        expect(sinkEvents).toEqual(['artifact.delta', 'artifact.done', 'task.status']);
        expect(result).toEqual({ id: 't-sink', status: 'completed', output: { text: 'hello' } });
    });

    it('returns input_required from streaming SSE without treating it as completion', async () => {
        const sentMessages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { sentMessages.push(text); },
        };
        const streamingInvoker = new JsonRpcInvoker({
            endpoint,
            streaming: true,
            chatSender: sender,
        });

        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseBody([
                cloudEvent('sse-input-1', {
                    id: 't-input',
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'before prompt' }],
                    },
                    final: false,
                }),
                cloudEvent('sse-input-2', {
                    id: 't-input',
                    status: {
                        state: 'input-required',
                        metadata: { token: 'tok-remote' },
                        message: {
                            role: 'agent',
                            parts: [{ type: 'text', text: 'Need more?' }],
                        },
                    },
                    final: false,
                }),
                cloudEvent('sse-input-3', {
                    id: 't-input',
                    status: { state: 'completed' },
                    final: true,
                }),
            ]),
        } as any);

        await expect(streamingInvoker.start({
            id: 't-input',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'hi' },
        })).resolves.toEqual({
            id: 't-input',
            status: 'input_required',
            token: 'tok-remote',
            prompt: 'Need more?',
        });

        expect(sentMessages).toEqual(['before prompt']);
    });

    it('streams resume() through tasks/resubscribe plus tasks/input', async () => {
        const sentMessages: string[] = [];
        const sender: ChatSender = {
            async sendMessage(_route, text) { sentMessages.push(text); },
        };
        const streamingInvoker = new JsonRpcInvoker({
            endpoint,
            headers: { Authorization: 'Bearer test' },
            streaming: true,
            chatSender: sender,
        });

        const fetchMock = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (_url, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.method === 'tasks/resubscribe') {
                return {
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: sseBody([
                        cloudEvent('sse-resume-1', {
                            id: 't-resume',
                            artifact: {
                                name: 'reply',
                                index: 0,
                                append: true,
                                parts: [{ type: 'text', text: 'after ' }],
                            },
                            final: false,
                        }),
                        cloudEvent('sse-resume-2', {
                            id: 't-resume',
                            artifact: {
                                name: 'reply',
                                index: 0,
                                append: true,
                                lastChunk: true,
                                parts: [{ type: 'text', text: 'input' }],
                            },
                            final: true,
                        }),
                        cloudEvent('sse-resume-3', {
                            id: 't-resume',
                            status: { state: 'completed' },
                            final: true,
                        }),
                    ]),
                } as Response;
            }
            if (body.method === 'tasks/input') {
                return {
                    json: async () => ({ jsonrpc: '2.0', result: { id: 't-resume', status: 'completed', output: { ok: true } } }),
                } as Response;
            }
            throw new Error(`Unexpected method ${body.method}`);
        });

        await expect(streamingInvoker.resume({
            id: 't-resume',
            token: 'tok',
            tenantId: 'web',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'answer' },
        })).resolves.toEqual({
            id: 't-resume',
            status: 'completed',
            output: { text: 'after input' },
        });

        const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
        expect(calls.map((body) => body.method)).toEqual(['tasks/resubscribe', 'tasks/input']);
        expect(calls[0]).toMatchObject({ params: { id: 't-resume', tenantId: 'web' } });
        expect(calls[1]).toMatchObject({
            params: {
                id: 't-resume',
                token: 'tok',
                tenantId: 'web',
                input: { text: 'answer' },
            },
        });
        expect(sentMessages).toEqual(['after ', 'input']);
    });

    it('resumeStream yields canonical runtime events from resubscribe SSE and posts input', async () => {
        const streamingInvoker = new JsonRpcInvoker({
            endpoint,
            headers: { Authorization: 'Bearer test' },
        });
        const fetchMock = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (_url, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.method === 'tasks/resubscribe') {
                return {
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: sseBody([
                        cloudEvent('resume-stream-method-1', {
                            id: 't-resume-stream',
                            artifact: {
                                name: 'reply',
                                index: 0,
                                append: true,
                                parts: [{ type: 'text', text: 'after input' }],
                            },
                            final: false,
                        }),
                        cloudEvent('resume-stream-method-2', {
                            id: 't-resume-stream',
                            status: { state: 'completed' },
                            final: true,
                        }),
                    ]),
                } as Response;
            }
            if (body.method === 'tasks/input') {
                return {
                    json: async () => ({ jsonrpc: '2.0', result: { id: 't-resume-stream', status: 'completed', output: { ok: true } } }),
                } as Response;
            }
            throw new Error(`Unexpected method ${body.method}`);
        });

        const events = await collectAsync(streamingInvoker.resumeStream({
            id: 't-resume-stream',
            token: 'tok',
            tenantId: 'web',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'answer' },
        }));

        const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
        expect(calls.map((body) => body.method)).toEqual(['tasks/resubscribe', 'tasks/input']);
        expect(events.map((event) => event.type)).toEqual(['artifact.delta', 'task.status']);
        expect(events[1]).toMatchObject({ type: 'task.status', data: { state: 'completed', terminal: true } });
    });

    it('resume with sink receives canonical runtime events and returns final result', async () => {
        const streamingInvoker = new JsonRpcInvoker({ endpoint });
        const sinkEvents: string[] = [];
        jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (_url, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.method === 'tasks/resubscribe') {
                return {
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: sseBody([
                        cloudEvent('resume-sink-method-1', {
                            id: 't-resume-sink',
                            artifact: {
                                name: 'reply',
                                index: 0,
                                append: true,
                                parts: [{ type: 'text', text: 'after input' }],
                            },
                            final: false,
                        }),
                        cloudEvent('resume-sink-method-2', {
                            id: 't-resume-sink',
                            status: { state: 'completed' },
                            final: true,
                        }),
                    ]),
                } as Response;
            }
            if (body.method === 'tasks/input') {
                return {
                    json: async () => ({ jsonrpc: '2.0', result: { id: 't-resume-sink', status: 'completed', output: { ok: true } } }),
                } as Response;
            }
            throw new Error(`Unexpected method ${body.method}`);
        });

        const result = await streamingInvoker.resume({
            id: 't-resume-sink',
            token: 'tok',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'answer' },
        }, async (event) => {
            sinkEvents.push(event.type);
        });

        expect(sinkEvents).toEqual(['artifact.delta', 'task.status']);
        expect(result).toEqual({ id: 't-resume-sink', status: 'completed', output: { text: 'after input' } });
    });
});

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) {
        items.push(item);
    }
    return items;
}

function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(`event: task.status\ndata: ${JSON.stringify(event)}\n\n`));
            }
            controller.close();
        },
    });
}

function cloudEvent(id: string, data: unknown): unknown {
    return {
        specversion: '1.0',
        id,
        type: 'task.status',
        source: '/tasks/t-stream',
        time: '2026-05-02T00:00:00.000Z',
        datacontenttype: 'application/json',
        data,
    };
}
