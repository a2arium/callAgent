import { ObservationSchema } from '../src/types/observation.js';

describe('Conversation observation schema', () => {
    it('accepts message.received envelope', () => {
        const parsed = ObservationSchema.parse({
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'msg-1',
                    conversation: { kind: 'thread', id: 'thread-1' },
                    senderAgentId: 'agent-a',
                    recipientAgentId: 'agent-b',
                    recipientMemberId: 'mem-b',
                    speechAct: 'question',
                    content: { text: 'hello' },
                    sequenceNumber: 1,
                    ts: new Date().toISOString(),
                },
            },
        });
        expect(parsed.source).toBe('conversation');
        expect(parsed.kind).toBe('message.received');
    });

    it('rejects malformed conversation speechAct', () => {
        const result = ObservationSchema.safeParse({
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'msg-1',
                    conversation: { kind: 'thread', id: 'thread-1' },
                    senderAgentId: 'agent-a',
                    recipientAgentId: 'agent-b',
                    recipientMemberId: 'mem-b',
                    speechAct: 'invalid',
                    content: { text: 'hello' },
                    sequenceNumber: 1,
                    ts: new Date().toISOString(),
                },
            },
        });
        expect(result.success).toBe(false);
    });
});

