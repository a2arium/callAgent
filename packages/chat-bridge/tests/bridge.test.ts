import { jest } from '@jest/globals';
import { createBridge } from '../src/internal/bridge.js';
import type { MessageNormalized, SessionRecord } from '../src/types.js';

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
        const invoker = { start: jest.fn(async () => ({ status: 'input_required', token: 'tok-new', prompt: 'need more' })) };
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
