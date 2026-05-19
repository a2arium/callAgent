import { jest } from '@jest/globals';
import { createBridge } from '../src/internal/bridge.js';
import type { MessageNormalized, RuntimeStreamSink, SessionRecord } from '../src/types.js';
import { RUNTIME_STREAM_EVENT_VERSION, type RuntimeStreamEvent } from '@a2arium/callagent-core';

const baseMessage = (overrides: Partial<MessageNormalized> = {}): MessageNormalized => ({
    network: 'web',
    conversationId: 'c1',
    messageId: 'm1',
    text: 'hi',
    userId: 'u1',
    ...overrides
});

describe('chat-bridge bridge', () => {
    const buildStore = (rec: SessionRecord | null) => {
        const store = {
            get: jest.fn(async () => rec),
            upsert: jest.fn(async () => { }),
            clear: jest.fn(async () => { }),
            markProcessed: jest.fn(async () => { }),
            wasProcessed: jest.fn(async () => false)
        };
        return store;
    };

    it('clears stale waitingInput sessions and notifies user', async () => {
        const stale = Date.now() - 30 * 60_000;
        const store = buildStore({ key: 'web:c1', agentId: 'a', taskId: 't', state: 'waitingInput', token: 'tok', lastActivityAt: stale } as SessionRecord);
        const chatSender = { sendMessage: jest.fn(async () => { }) };
        const bridge = createBridge({
            sessionStore: store,
            agentSelector: jest.fn(),
            chatSender: chatSender as any,
            invoker: {} as any,
            timeouts: { inputWaitMs: 1_000 },
            logger: fakeLogger(),
            metrics: fakeMetrics()
        });

        await bridge.handleIncomingMessage(baseMessage());

        expect(store.clear).toHaveBeenCalledWith('web:c1');
        expect(chatSender.sendMessage).toHaveBeenCalled();
    });

    it('resumes waiting input when within timeout', async () => {
        const recent = Date.now() - 500;
        const store = buildStore({ key: 'web:c1', agentId: 'a', taskId: 't1', state: 'waitingInput', token: 'tok', lastActivityAt: recent } as SessionRecord);
        const chatSender = { sendMessage: jest.fn(async () => { }) };
        const invoker = { resume: jest.fn(async () => ({ status: 'completed', output: 'done', id: 't1' })) };
        const bridge = createBridge({
            sessionStore: store,
            agentSelector: jest.fn(),
            chatSender: chatSender as any,
            invoker: invoker as any,
            timeouts: { inputWaitMs: 60_000 },
            logger: fakeLogger(),
            metrics: fakeMetrics()
        });

        await bridge.handleIncomingMessage(baseMessage());

        expect(invoker.resume).toHaveBeenCalled();
        expect(chatSender.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1' }), 'done');
        expect(store.clear).toHaveBeenCalledWith('web:c1');
    });

    it('starts new task and records waiting input with prompt', async () => {
        const store = buildStore(null);
        const chatSender = { sendMessage: jest.fn(async () => { }) };
        const invoker = { start: jest.fn(async () => ({ id: 'task-input', status: 'input_required', token: 'tok-new', prompt: 'need more' })) };
        const realtime = { publish: jest.fn(async () => { }) };
        const bridge = createBridge({
            sessionStore: store,
            agentSelector: jest.fn(async () => 'agent-1'),
            chatSender: chatSender as any,
            invoker: invoker as any,
            realtime,
            logger: fakeLogger(),
            metrics: fakeMetrics()
        });

        await bridge.handleIncomingMessage(baseMessage({ text: '/new' })); // clear any previous with /new
        await bridge.handleIncomingMessage(baseMessage({ text: 'hello' }));

        expect(invoker.start).toHaveBeenCalled();
        expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ state: 'waitingInput', token: 'tok-new' }));
        expect(chatSender.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1' }), 'need more');
        expect(realtime.publish).toHaveBeenCalledWith('web:c1', expect.objectContaining({ type: 'input_required', token: 'tok-new' }));
    });

    it('passes a runtime stream sink and forwards live chat plus realtime events', async () => {
        const store = buildStore(null);
        const sentMessages: string[] = [];
        const typingRoutes: unknown[] = [];
        const chatSender = {
            sendMessage: jest.fn(async (_route, text: string) => { sentMessages.push(text); }),
            sendTyping: jest.fn(async (route) => { typingRoutes.push(route); }),
        };
        const realtime = { publish: jest.fn(async () => { }) };
        const invoker = {
            start: jest.fn(async (_params, sink?: RuntimeStreamSink) => {
                await sink?.(runtimeEvent('task.status', {
                    state: 'working',
                    terminal: false,
                    message: { role: 'agent', parts: [{ type: 'text', text: 'Working' }] },
                    metadata: { progress: 40 },
                }, 1));
                await sink?.(runtimeEvent('artifact.delta', {
                    artifactId: 'reply',
                    index: 0,
                    append: true,
                    parts: [{ type: 'text', text: 'hello' }],
                }, 2));
                await sink?.(runtimeEvent('task.status', {
                    state: 'completed',
                    terminal: true,
                }, 3));
                return { id: 'task-live', status: 'completed', output: { text: 'hello' } };
            }),
            resume: jest.fn(),
        };
        const bridge = createBridge({
            sessionStore: store,
            agentSelector: jest.fn(async () => 'agent-1'),
            chatSender,
            invoker,
            realtime,
            logger: fakeLogger(),
            metrics: fakeMetrics(),
        });

        await bridge.handleIncomingMessage(baseMessage({ text: 'stream please' }));

        expect(invoker.start).toHaveBeenCalledWith(expect.any(Object), expect.any(Function));
        expect(typingRoutes).toEqual([expect.objectContaining({ conversationId: 'c1' })]);
        expect(sentMessages).toEqual(['hello']);
        expect(realtime.publish).toHaveBeenCalledWith('web:c1', expect.objectContaining({
            type: 'progress',
            pct: 40,
            status: 'Working',
        }));
        expect(realtime.publish).toHaveBeenCalledWith('web:c1', expect.objectContaining({
            type: 'reply',
            text: 'hello',
        }));
        expect(realtime.publish).toHaveBeenCalledWith('web:c1', expect.objectContaining({
            type: 'completed',
        }));
        expect(realtime.publish.mock.calls.filter(([, event]) => event.type === 'completed')).toHaveLength(1);
        expect(store.clear).toHaveBeenCalledWith('web:c1');
    });
});

function fakeLogger() {
    return {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
}

function fakeMetrics() {
    return { incr: jest.fn(), observe: jest.fn() };
}

function runtimeEvent(type: 'task.status' | 'artifact.delta', data: unknown, seq: number): RuntimeStreamEvent {
    return {
        version: RUNTIME_STREAM_EVENT_VERSION,
        id: `runtime-${seq}`,
        seq,
        taskId: 'task-live',
        tenantId: 'web',
        agentId: 'agent-1',
        ts: '2026-05-04T00:00:00.000Z',
        type,
        visibility: 'public',
        channel: 'user',
        data,
    } as RuntimeStreamEvent;
}
