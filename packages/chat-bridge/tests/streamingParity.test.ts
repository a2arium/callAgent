import {
    PluginManager,
    createBusEvent,
    createInMemoryEventBus,
    taskChannel,
    type A2AEvent,
} from '@a2arium/callagent-core';
import { jest } from '@jest/globals';
import { JsonRpcInvoker } from '../src/clients/jsonRpcInvoker.js';
import { ProgrammaticInvoker } from '../src/internal/invokers/programmaticInvoker.js';
import type { ChatRoute, ChatSender, ResultPayload } from '../src/types.js';

type ChatCall =
    | { type: 'typing'; route: ChatRoute }
    | { type: 'message'; route: ChatRoute; text: string; parseMode?: 'plain' | 'markdown' | 'html' }
    | { type: 'media'; route: ChatRoute; media: unknown }
    | { type: 'markup'; route: ChatRoute; markup: unknown };

describe('chat bridge streaming parity', () => {
    const endpoint = 'https://api.example.com/rpc';
    const taskId = 'task-parity';
    const tenantId = 'web';
    const route: ChatRoute = { network: 'web', conversationId: 'c1' };

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('programmatic and remote start produce equivalent chat calls and results', async () => {
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({} as any);

        const programmatic = await runProgrammaticStart(parityEvents(taskId));
        const remote = await runRemoteStart(parityEvents(taskId));

        expect(programmatic).toEqual(remote);
        expect(programmatic).toEqual({
            calls: [
                { type: 'typing', route },
                { type: 'message', route, text: 'hello ', parseMode: 'markdown' },
                { type: 'media', route, media: { type: 'image', url: 'https://example.test/image.png', caption: 'image' } },
                { type: 'markup', route, markup: { kind: 'buttons', prompt: 'choose', buttons: [{ title: 'A', payload: 'a' }] } },
                { type: 'message', route, text: 'world', parseMode: undefined },
            ],
            result: {
                id: taskId,
                status: 'completed',
                output: { text: 'hello world' },
            },
        });
    });

    async function runProgrammaticStart(events: A2AEvent[]): Promise<{ calls: ChatCall[]; result: ResultPayload }> {
        const bus = createInMemoryEventBus();
        const calls: ChatCall[] = [];
        const sender = recordingSender(calls);

        const publish = async (event: A2AEvent, index: number) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id: `programmatic-${index}`,
                    type: 'task.event',
                    source: 'streaming-parity.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };

        const engine = {
            async startTask() {
                for (const [index, event] of events.entries()) {
                    await publish(event, index);
                }
            },
            async resumeInput() { },
        };

        const invoker = new ProgrammaticInvoker({
            chatSender: sender,
            runtime: {
                engine,
                eventBus: bus,
                taskChannel,
                wmStore: { listEventsSince: jest.fn(async () => []) },
            },
        });

        const result = await invoker.start({
            id: taskId,
            agentId: 'agent',
            tenantId,
            route,
            input: { route, text: 'hi' },
        });
        return { calls, result };
    }

    async function runRemoteStart(events: A2AEvent[]): Promise<{ calls: ChatCall[]; result: ResultPayload }> {
        const calls: ChatCall[] = [];
        const sender = recordingSender(calls);

        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseBody(events.map((event, index) => cloudEvent(`remote-${index}`, event))),
        } as any);

        const invoker = new JsonRpcInvoker({
            endpoint,
            streaming: true,
            chatSender: sender,
        });

        const result = await invoker.start({
            id: taskId,
            agentId: 'agent',
            tenantId,
            route,
            input: { route, text: 'hi' },
        });
        return { calls, result };
    }

    function recordingSender(calls: ChatCall[]): ChatSender {
        return {
            async sendTyping(routeArg) {
                calls.push({ type: 'typing', route: routeArg });
            },
            async sendMessage(routeArg, text, options) {
                calls.push({ type: 'message', route: routeArg, text, parseMode: options?.parseMode });
            },
            async sendMedia(routeArg, media) {
                calls.push({ type: 'media', route: routeArg, media });
            },
            async sendMarkup(routeArg, markup) {
                calls.push({ type: 'markup', route: routeArg, markup });
            },
        };
    }
});

function parityEvents(taskId: string): A2AEvent[] {
    return [
        {
            id: taskId,
            status: { state: 'working' },
            final: false,
        },
        {
            id: taskId,
            artifact: {
                name: 'reply',
                index: 0,
                append: true,
                parts: [
                    { type: 'text', text: 'hello ', format: 'markdown' },
                    { type: 'image', url: 'https://example.test/image.png', caption: 'image' },
                    { type: 'markup', value: JSON.stringify({ kind: 'buttons', prompt: 'choose', buttons: [{ title: 'A', payload: 'a' }] }) },
                ],
            },
            final: false,
        },
        {
            id: taskId,
            artifact: {
                name: 'reply',
                index: 0,
                append: true,
                lastChunk: true,
                parts: [{ type: 'text', text: 'world' }],
            },
            final: true,
        },
        {
            id: taskId,
            status: { state: 'completed' },
            final: true,
        },
    ];
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
        source: '/tasks/task-parity',
        time: '2026-05-02T00:00:00.000Z',
        datacontenttype: 'application/json',
        data,
    };
}
