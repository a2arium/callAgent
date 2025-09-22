import { createBridge } from '../src/internal/bridge.js';
import type { BridgeOptions, SessionRecord, MessageNormalized } from '../src/types.js';

function msg(text: string, overrides: Partial<MessageNormalized> = {}): MessageNormalized {
    return {
        network: 'telegram',
        conversationId: 'conv1',
        userId: 'user1',
        messageId: String(Date.now() + Math.random()),
        text,
        ...overrides
    };
}

describe('Bridge + fake invoker integration flow', () => {
    test('start -> input_required -> resume -> completed with chat sends', async () => {
        const sent: string[] = [];
        const store: any = {
            rec: null as SessionRecord | null,
            async get(key: string) { return this.rec; },
            async upsert(r: SessionRecord) { this.rec = r; },
            async clear() { this.rec = null; },
            async wasProcessed() { return false; },
            async markProcessed() { }
        };
        const chatSender = { sendMessage: async (_r: any, t: string) => { sent.push(t); } } as BridgeOptions['chatSender'];
        const token = 'tok-123';
        const invoker = {
            start: async () => ({ id: 'task-1', status: 'input_required', token }),
            resume: async () => ({ id: 'task-1', status: 'completed', output: { text: 'FINAL' } })
        } as any;
        const bridge = createBridge({ sessionStore: store, agentSelector: async () => 'agent-x', chatSender, invoker, timeouts: { inputWaitMs: 60_000 } } as any);

        // First message triggers input_required and saves token
        await bridge.handleIncomingMessage(msg('hello'));
        expect(store.rec?.state).toBe('waitingInput');
        expect(store.rec?.token).toBe(token);
        expect(sent.pop()).toMatch(/Please provide/);

        // Next user message is treated as input -> completed
        await bridge.handleIncomingMessage(msg('my answer'));
        expect(store.rec).toBeNull();
        expect(sent.join(' ')).toMatch(/FINAL/);
    });
});


