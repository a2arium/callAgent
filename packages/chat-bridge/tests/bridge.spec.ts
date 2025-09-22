import { createBridge } from '../src/internal/bridge.js';
import type { BridgeOptions, MessageNormalized, SessionRecord } from '../src/types.js';

function msg(partial: Partial<MessageNormalized> = {}): MessageNormalized {
    return {
        network: 'telegram',
        conversationId: 'c1',
        userId: 'u1',
        messageId: String(Date.now()),
        text: 'hello',
        ...partial
    };
}

describe('ChatBridge routing/idempotency/timeout', () => {
    test('start -> completed clears session and sends message', async () => {
        const events: string[] = [];
        const store: any = {
            rec: null as SessionRecord | null,
            async get() { return this.rec; },
            async upsert(r: SessionRecord) { this.rec = r; },
            async clear() { this.rec = null; },
            async wasProcessed() { return false; },
            async markProcessed() { }
        };
        const chatSender = { sendMessage: async (_r: any, t: string) => { events.push(t); } } as BridgeOptions['chatSender'];
        const invoker = { start: async () => ({ id: 't1', status: 'completed', output: { text: 'OK' } }), resume: async () => ({ id: 't1', status: 'completed', output: { text: 'OK' } }) } as any;
        const bridge = createBridge({ sessionStore: store, agentSelector: async () => 'a1', chatSender, invoker, timeouts: { inputWaitMs: 1000 } } as any);
        await bridge.handleIncomingMessage(msg());
        expect(events.join(' ')).toContain('OK');
        expect(store.rec).toBeNull();
    });

    test('waitingInput -> resume', async () => {
        const events: string[] = [];
        const store: any = {
            rec: { key: 'telegram:c1', agentId: 'a1', taskId: 't1', state: 'waitingInput', token: 'tok', lastActivityAt: Date.now() } as SessionRecord,
            async get() { return this.rec; },
            async upsert(r: SessionRecord) { this.rec = r; },
            async clear() { this.rec = null; },
            async wasProcessed() { return false; },
            async markProcessed() { }
        };
        const chatSender = { sendMessage: async (_r: any, t: string) => { events.push(t); } } as BridgeOptions['chatSender'];
        const invoker = { resume: async () => ({ id: 't1', status: 'completed', output: { text: 'DONE' } }) } as any;
        const bridge = createBridge({ sessionStore: store, agentSelector: async () => 'a1', chatSender, invoker, timeouts: { inputWaitMs: 1000 } } as any);
        await bridge.handleIncomingMessage(msg({ text: '42' }));
        expect(events.join(' ')).toContain('DONE');
        expect(store.rec).toBeNull();
    });

    test('idempotency drops duplicates', async () => {
        const drops: string[] = [];
        const store: any = {
            async get() { return null; },
            async upsert() { },
            async clear() { },
            async wasProcessed() { return true; },
            async markProcessed() { }
        };
        const chatSender = { sendMessage: async () => { drops.push('sent'); } } as BridgeOptions['chatSender'];
        const invoker = { start: async () => ({ id: 't1', status: 'completed', output: { text: 'SHOULD_NOT_SEND' } }) } as any;
        const bridge = createBridge({ sessionStore: store, agentSelector: async () => 'a1', chatSender, invoker } as any);
        await bridge.handleIncomingMessage(msg());
        expect(drops.length).toBe(0);
    });

    test('input timeout clears session and notifies', async () => {
        const notes: string[] = [];
        const store: any = {
            rec: { key: 'telegram:c1', agentId: 'a1', taskId: 't1', state: 'waitingInput', token: 'tok', lastActivityAt: Date.now() - 10_000 } as SessionRecord,
            async get() { return this.rec; },
            async upsert(r: SessionRecord) { this.rec = r; },
            async clear() { this.rec = null; }
        };
        const chatSender = { sendMessage: async (_r: any, t: string) => { notes.push(t); } } as BridgeOptions['chatSender'];
        const bridge = createBridge({ sessionStore: store, agentSelector: async () => 'a1', chatSender, invoker: {} as any, timeouts: { inputWaitMs: 1000 } } as any);
        await bridge.handleIncomingMessage(msg({ text: 'hi' }));
        expect(notes.join(' ')).toContain('expired');
        expect(store.rec).toBeNull();
    });
});


