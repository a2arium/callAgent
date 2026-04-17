import { reduceConversationProjection } from '../src/loop/learning/conversationReducer.js';
import type { Observation } from '../src/types/observation.js';
import { memberId } from '../src/public-types/conversation/index.js';

describe('reduceConversationProjection', () => {
    const topic = { kind: 'topic' as const, id: 'topic-proj-1' };

    it('adds members on topic.member.joined', () => {
        const obs: Observation = {
            source: 'conversation',
            payload: {
                kind: 'topic.member.joined',
                topic,
                member: {
                    agentId: 'a1',
                    memberId: memberId('a1'),
                    role: 'owner',
                    sessionId: `topic-${topic.id}:a1`,
                },
                ts: '2020-01-01T00:00:00.000Z',
            },
        } as Observation;
        const p = reduceConversationProjection(undefined, [obs]);
        expect(p.topics[topic.id]?.members).toEqual([{ agentId: 'a1', memberId: 'a1', role: 'owner' }]);
        expect(Object.isFrozen(p)).toBe(true);
    });

    it('updates lastInboundSequence on topic.message.received', () => {
        const obs: Observation = {
            source: 'conversation',
            payload: {
                kind: 'topic.message.received',
                topic,
                selector: { kind: 'broadcast' },
                message: {
                    id: 'm1',
                    conversation: topic,
                    senderAgentId: 'owner',
                    recipientAgentId: 'p1',
                    recipientMemberId: memberId('p1'),
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 3,
                    ts: '2020-01-01T00:00:00.000Z',
                },
                recipient: { memberId: memberId('p1'), agentId: 'p1' },
            },
        } as Observation;
        const p = reduceConversationProjection(undefined, [obs]);
        expect(p.topics[topic.id]?.lastInboundSequence).toBe(3);
    });

    it('clears pendingOutgoing on delivery.failed for thread', () => {
        const thread = { kind: 'thread' as const, id: 'th-1' };
        const prev = reduceConversationProjection(undefined, [
            {
                source: 'conversation',
                payload: {
                    kind: 'message.received',
                    message: {
                        id: 'm0',
                        conversation: thread,
                        senderAgentId: 'b',
                        recipientAgentId: 'a',
                        recipientMemberId: memberId('a'),
                        speechAct: 'inform',
                        content: {},
                        sequenceNumber: 1,
                        ts: '2020-01-01T00:00:00.000Z',
                    },
                },
            } as Observation,
        ]);
        const withPending = {
            ...prev,
            threads: {
                ...prev.threads,
                [thread.id]: { ...prev.threads[thread.id]!, pendingOutgoing: true },
            },
        };
        const p = reduceConversationProjection(withPending, [
            {
                source: 'conversation',
                payload: {
                    kind: 'delivery.failed',
                    thread,
                    error: { type: 'Unsupported', message: 'x' },
                },
            } as Observation,
        ]);
        expect(p.threads[thread.id]?.pendingOutgoing).toBe(false);
    });
});
