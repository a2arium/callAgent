import {
    PluginManager,
    TaskEngine,
    createBusEvent,
    createInMemoryEventBus,
    taskChannel,
    type A2AEvent,
    type RuntimeStreamChatProjectionEvent,
} from '@a2arium/callagent-core';
import { InMemorySessionManager } from '../../core/src/orchestration/InMemorySessionManager.js';
import { TaskExecutor } from '../../core/src/orchestration/TaskExecutor.js';
import { initialM } from '../../core/src/loop/init.js';
import { setPendingInputs } from '../../core/src/orchestration/DurableHandlerRegistry.js';
import { jest } from '@jest/globals';
import {
    createStreamForwardState,
    forwardChatProjectionEvent,
} from '../src/internal/invokers/chatProjectionForwarder.js';
import { ProgrammaticInvoker } from '../src/internal/invokers/programmaticInvoker.js';
import type { Attachment, ChatRoute, ChatSender, Markup } from '../src/types.js';

describe('ProgrammaticInvoker', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('exposes start and resume entrypoints', () => {
        const sender: ChatSender = {
            async sendMessage() { },
        };
        const invoker = new ProgrammaticInvoker({ chatSender: sender });

        expect(typeof invoker.start).toBe('function');
        expect(typeof invoker.resume).toBe('function');
    });

    test('real loop resume delivers reply and the next input prompt to chat', async () => {
        const taskId = 'task-real-chat-resume';
        const tenantId = 'tenant-real-chat-resume';
        const agentId = 'agent-real-chat-resume';
        const inputToken = 'existing-input-token';
        const route: ChatRoute = { network: 'web', conversationId: 'real-user' };
        const bus = createInMemoryEventBus();
        const store = new InMemorySessionManager();
        const sentMessages: string[] = [];

        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({
            resolved: {
                runtimeManifest: {
                    name: agentId,
                    version: '1.0.0',
                    runMode: 'loop',
                    budgets: { maxTurns: 5 },
                },
                agentCard: { name: agentId, version: '1.0.0' },
            },
        } as any);
        jest.spyOn(TaskExecutor, 'executeTurn').mockImplementation(async (params) => {
            await params.ctx.reply('reply after button');
            const nextInput = await params.ctx.requestInput('Choose again');
            return {
                M: params.M ?? initialM(params.ctx),
                outcome: { kind: 'await_input', token: nextInput.token },
                metrics: {},
                taskStatus: {
                    state: 'input-required',
                    timestamp: new Date().toISOString(),
                    metadata: { token: nextInput.token },
                },
            };
        });
        await store.writeSnapshotCAS({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: setPendingInputs(
                {
                    meta: {
                        agentId,
                        turnCoordinator: {
                            schemaVersion: 1,
                            nextFence: '0',
                            nextTurnSeq: 0,
                            requestedGeneration: '0',
                            completedGeneration: '0',
                        },
                    },
                },
                { [inputToken]: {} }
            ),
        });

        const engine = new TaskEngine({ sessionStore: store, eventBus: bus });
        const invoker = new ProgrammaticInvoker({
            chatSender: {
                async sendMessage(_routeArg, text) {
                    sentMessages.push(text);
                },
            },
            runtime: {
                engine,
                eventBus: bus,
                taskChannel,
                wmStore: store,
            },
        });

        const result = await invoker.resume({
            id: taskId,
            token: inputToken,
            input: { route, text: 'more' },
            tenantId,
            route,
        });

        expect(result).toMatchObject({
            id: taskId,
            status: 'input_required',
            prompt: 'Choose again',
        });
        expect(sentMessages).toEqual(['reply after button', 'Choose again']);
        const persisted = await store.getSessionSnapshot(tenantId, taskId);
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('stream');
    });

    test('streams bus events to chat and resolves on terminal task status', async () => {
        const taskId = 'task-chat-stream';
        const tenantId = 'tenant-chat-stream';
        const agentId = 'agent-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const sentMessages: string[] = [];
        const typingCalls: ChatRoute[] = [];
        const terminalChecks: boolean[] = [];

        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({} as any);

        const publishA2AEvent = async (event: A2AEvent) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id: `event-${terminalChecks.length}`,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };

        const engine = {
            async startTask() {
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'working' },
                    final: false,
                });
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello ' }],
                    },
                    final: true,
                });
                terminalChecks.push(sentMessages.join('') === 'hello ');
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'world' }],
                    },
                    final: false,
                });
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                });
            },
            async resumeInput() { },
        };

        const sender: ChatSender = {
            async sendMessage(_routeArg, text) { sentMessages.push(text); },
            async sendTyping(routeArg) { typingCalls.push(routeArg); },
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

        await expect(invoker.start({
            id: taskId,
            input: { route, text: 'start' },
            agentId,
            tenantId,
            route,
        })).resolves.toEqual({
            id: taskId,
            status: 'completed',
            output: { text: 'hello world' },
        });

        expect(typingCalls).toEqual([route]);
        expect(sentMessages).toEqual(['hello ', 'world']);
        expect(terminalChecks).toEqual([true]);
    });

    test('startStream yields canonical runtime events from bus events', async () => {
        const taskId = 'task-programmatic-start-stream';
        const tenantId = 'tenant-chat-stream';
        const agentId = 'agent-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();

        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({} as any);

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };
        const engine = {
            async startTask() {
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello' }],
                    },
                    final: true,
                }, 'start-stream-artifact');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'start-stream-completed');
            },
            async resumeInput() { },
        };
        const sender: ChatSender = {
            async sendMessage() { },
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

        const events = await collectAsync(invoker.startStream({
            id: taskId,
            input: { route, text: 'start' },
            agentId,
            tenantId,
            route,
        }));

        expect(events.map((event) => event.type)).toEqual(['artifact.delta', 'artifact.done', 'task.status']);
        expect(events[1]).toMatchObject({ type: 'artifact.done', data: { artifactId: 'reply' } });
        expect(events[2]).toMatchObject({ type: 'task.status', data: { state: 'completed', terminal: true } });
    });

    test('start with sink receives canonical runtime events and returns final result', async () => {
        const taskId = 'task-programmatic-sink';
        const tenantId = 'tenant-chat-stream';
        const agentId = 'agent-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const sinkEvents: string[] = [];

        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({} as any);

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };
        const engine = {
            async startTask() {
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'hello' }],
                    },
                    final: true,
                }, 'sink-artifact');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'sink-completed');
            },
            async resumeInput() { },
        };
        const invoker = new ProgrammaticInvoker({
            chatSender: { async sendMessage() { } },
            runtime: {
                engine,
                eventBus: bus,
                taskChannel,
                wmStore: { listEventsSince: jest.fn(async () => []) },
            },
        });

        const result = await invoker.start({
            id: taskId,
            input: { route, text: 'start' },
            agentId,
            tenantId,
            route,
        }, async (event) => {
            sinkEvents.push(event.type);
        });

        expect(sinkEvents).toEqual(['artifact.delta', 'artifact.done', 'task.status']);
        expect(result).toEqual({ id: taskId, status: 'completed', output: { text: 'hello' } });
    });

    test('resume streams bus events to chat and resolves on terminal task status', async () => {
        const taskId = 'task-chat-resume-stream';
        const tenantId = 'tenant-chat-stream';
        const token = 'resume-token';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const sentMessages: string[] = [];
        const resumeCalls: Array<{
            tenantId: string;
            taskId: string;
            token: string;
            inputText?: string;
            isStreaming?: boolean;
        }> = [];

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };

        const engine = {
            async startTask() { },
            async resumeInput(params: {
                tenantId: string;
                taskId: string;
                token: string;
                input: { text?: string };
                isStreaming?: boolean;
            }) {
                resumeCalls.push({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    token: params.token,
                    inputText: params.input.text,
                    isStreaming: params.isStreaming,
                });
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'after ' }],
                    },
                    final: false,
                }, 'resume-event-1');
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        lastChunk: true,
                        parts: [{ type: 'text', text: 'input' }],
                    },
                    final: true,
                }, 'resume-event-2');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'resume-event-3');
            },
        };

        const sender: ChatSender = {
            async sendMessage(_routeArg, text) { sentMessages.push(text); },
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

        await expect(invoker.resume({
            id: taskId,
            token,
            input: { route, text: 'answer' },
            tenantId,
            route,
        })).resolves.toEqual({
            id: taskId,
            status: 'completed',
            output: { text: 'after input' },
        });

        expect(resumeCalls).toEqual([{
            tenantId,
            taskId,
            token,
            inputText: 'answer',
            isStreaming: true,
        }]);
        expect(sentMessages).toEqual(['after ', 'input']);
    });

    test('resumeStream yields canonical runtime events after resuming input', async () => {
        const taskId = 'task-programmatic-resume-stream';
        const tenantId = 'tenant-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const resumeCalls: Array<{
            tenantId: string;
            taskId: string;
            token: string;
            isStreaming?: boolean;
        }> = [];

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };
        const engine = {
            async startTask() { },
            async resumeInput(params: {
                tenantId: string;
                taskId: string;
                token: string;
                isStreaming?: boolean;
            }) {
                resumeCalls.push(params);
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'after input' }],
                    },
                    final: false,
                }, 'resume-stream-artifact');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'resume-stream-completed');
            },
        };
        const sender: ChatSender = {
            async sendMessage() { },
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

        const events = await collectAsync(invoker.resumeStream({
            id: taskId,
            token: 'tok',
            input: { route, text: 'answer' },
            tenantId,
            route,
        }));

        expect(resumeCalls).toEqual([
            expect.objectContaining({
                tenantId,
                taskId,
                token: 'tok',
                isStreaming: true,
            }),
        ]);
        expect(events.map((event) => event.type)).toEqual(['artifact.delta', 'task.status']);
        expect(events[1]).toMatchObject({ type: 'task.status', data: { state: 'completed', terminal: true } });
    });

    test('resume with sink receives canonical runtime events and returns final result', async () => {
        const taskId = 'task-programmatic-resume-sink';
        const tenantId = 'tenant-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const sinkEvents: string[] = [];

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };
        const engine = {
            async startTask() { },
            async resumeInput() {
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'after input' }],
                    },
                    final: false,
                }, 'resume-sink-artifact');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'resume-sink-completed');
            },
        };
        const invoker = new ProgrammaticInvoker({
            chatSender: { async sendMessage() { } },
            runtime: {
                engine,
                eventBus: bus,
                taskChannel,
                wmStore: { listEventsSince: jest.fn(async () => []) },
            },
        });

        const result = await invoker.resume({
            id: taskId,
            token: 'tok',
            input: { route, text: 'answer' },
            tenantId,
            route,
        }, async (event) => {
            sinkEvents.push(event.type);
        });

        expect(sinkEvents).toEqual(['artifact.delta', 'task.status']);
        expect(result).toEqual({ id: taskId, status: 'completed', output: { text: 'after input' } });
    });

    test('returns input_required from canonical bus projection without completing the stream', async () => {
        const taskId = 'task-chat-input-required';
        const tenantId = 'tenant-chat-stream';
        const agentId = 'agent-chat-stream';
        const route: ChatRoute = { network: 'web', conversationId: 'u1' };
        const bus = createInMemoryEventBus();
        const sentMessages: string[] = [];
        const completedAfterInputRequired: boolean[] = [];

        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({} as any);

        const publishA2AEvent = async (event: A2AEvent, id: string) => {
            await bus.publish(createBusEvent({
                channel: taskChannel(taskId),
                cloud: {
                    id,
                    type: 'task.event',
                    source: 'programmatic-invoker.test',
                    time: '2026-05-02T00:00:00.000Z',
                    data: event,
                },
            }));
        };

        const engine = {
            async startTask() {
                await publishA2AEvent({
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'before prompt' }],
                    },
                    final: false,
                }, 'input-required-event-1');
                await publishA2AEvent({
                    id: taskId,
                    status: {
                        state: 'input-required',
                        metadata: { token: 'tok-live' },
                        message: {
                            role: 'agent',
                            parts: [{ type: 'text', text: 'Need more details?' }],
                        },
                    },
                    final: false,
                }, 'input-required-event-2');
                await publishA2AEvent({
                    id: taskId,
                    status: { state: 'completed' },
                    final: true,
                }, 'input-required-event-3');
                completedAfterInputRequired.push(true);
            },
            async resumeInput() { },
        };

        const sender: ChatSender = {
            async sendMessage(_routeArg, text) { sentMessages.push(text); },
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

        await expect(invoker.start({
            id: taskId,
            input: { route, text: 'start' },
            agentId,
            tenantId,
            route,
        })).resolves.toEqual({
            id: taskId,
            status: 'input_required',
            token: 'tok-live',
            prompt: 'Need more details?',
        });

        expect(sentMessages).toEqual(['before prompt']);
        expect(completedAfterInputRequired).toEqual([true]);
    });
});

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) {
        items.push(item);
    }
    return items;
}

describe('chat projection forwarding', () => {
    const route: ChatRoute = { network: 'web', conversationId: 'u1' };
    const ts = '2026-05-02T00:00:00.000Z';

    test('throttles typing indicators', async () => {
        const typingCalls: ChatRoute[] = [];
        const sender: ChatSender = {
            async sendMessage() { },
            async sendTyping(routeArg) { typingCalls.push(routeArg); },
        };
        const state = createStreamForwardState();
        const event: RuntimeStreamChatProjectionEvent = { type: 'typing', taskId: 't1', seq: 1, ts };

        await forwardChatProjectionEvent({ sender, route, state, event, now: () => 1001 });
        await forwardChatProjectionEvent({ sender, route, state, event, now: () => 1500 });
        await forwardChatProjectionEvent({ sender, route, state, event, now: () => 2102 });

        expect(typingCalls).toEqual([route, route]);
    });

    test('sends text chunks and returns aggregated text on completion', async () => {
        const sent: Array<{ text: string; parseMode?: 'plain' | 'markdown' | 'html' }> = [];
        const sender: ChatSender = {
            async sendMessage(_routeArg, text, options) {
                sent.push({ text, parseMode: options?.parseMode });
            },
        };
        const state = createStreamForwardState();

        await forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: { type: 'message', taskId: 't1', seq: 1, ts, text: 'hello ', parseMode: 'markdown' },
        });
        await forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: { type: 'message', taskId: 't1', seq: 2, ts, text: 'world' },
        });
        const result = await forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: { type: 'completed', taskId: 't1', seq: 3, ts },
        });

        expect(sent).toEqual([
            { text: 'hello ', parseMode: 'markdown' },
            { text: 'world', parseMode: undefined },
        ]);
        expect(result).toEqual({ kind: 'completed', output: { text: 'hello world' } });
    });

    test('forwards media and markup projection events', async () => {
        const media: Attachment[] = [];
        const markups: Markup[] = [];
        const sender: ChatSender = {
            async sendMessage() { },
            async sendMedia(_routeArg, value) { media.push(value); },
            async sendMarkup(_routeArg, value) { markups.push(value); },
        };
        const state = createStreamForwardState();

        await forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: {
                type: 'media',
                taskId: 't1',
                seq: 1,
                ts,
                media: { type: 'image', url: 'https://example.test/image.png', caption: 'image' },
            },
        });
        await forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: {
                type: 'markup',
                taskId: 't1',
                seq: 2,
                ts,
                value: JSON.stringify({ kind: 'buttons', prompt: 'choose', buttons: [{ title: 'A', payload: 'a' }] }),
            },
        });

        expect(media).toEqual([{ type: 'image', url: 'https://example.test/image.png', caption: 'image' }]);
        expect(markups).toEqual([{ kind: 'buttons', prompt: 'choose', buttons: [{ title: 'A', payload: 'a' }] }]);
    });

    test('returns bridge terminal states for input, errors, and empty completions', async () => {
        const sender: ChatSender = {
            async sendMessage() { },
        };
        const state = createStreamForwardState();

        await expect(forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: { type: 'input_required', taskId: 't1', seq: 1, ts, token: 'tok', prompt: 'need more' },
        })).resolves.toEqual({ kind: 'input_required', token: 'tok', prompt: 'need more' });

        await expect(forwardChatProjectionEvent({
            sender,
            route,
            state,
            event: { type: 'error', taskId: 't1', seq: 2, ts, message: 'failed' },
        })).resolves.toEqual({ kind: 'failed', error: 'failed' });

        await expect(forwardChatProjectionEvent({
            sender,
            route,
            state: createStreamForwardState(),
            event: { type: 'completed', taskId: 't1', seq: 3, ts },
        })).resolves.toEqual({ kind: 'completed', output: { ok: true } });
    });
});
