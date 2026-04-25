import { ObservationSchema } from '../src/types/observation.js';

describe('Topic conversation observations', () => {
    it('parses topic.message.received', () => {
        const parsed = ObservationSchema.parse({
            source: 'conversation',
            payload: {
                kind: 'topic.message.received',
                topic: { kind: 'topic', id: 't1' },
                selector: { kind: 'broadcast' },
                recipient: { by: 'agentId', agentId: 'b', memberId: 'member-b' },
                message: {
                    id: 'mid',
                    conversation: { kind: 'topic', id: 't1' },
                    senderAgentId: 'a',
                    senderMemberId: 'member-a',
                    recipientAgentId: 'b',
                    recipientMemberId: 'member-b',
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 1,
                    ts: '2020-01-01T00:00:00.000Z',
                },
            },
        });
        expect(parsed.kind).toBe('topic.message.received');
    });

    it('derives outer kind from payload for conversation source', () => {
        const parsed = ObservationSchema.parse({
            source: 'conversation',
            payload: {
                kind: 'topic.closed',
                topic: { kind: 'topic', id: 't1' },
                ts: '2020-01-01T00:00:00.000Z',
            },
        });
        expect(parsed.kind).toBe('topic.closed');
    });
});
