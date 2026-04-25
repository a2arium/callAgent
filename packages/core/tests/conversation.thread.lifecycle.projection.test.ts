import { reduceConversationProjection } from '../src/loop/learning/conversationReducer.js';
import type { Observation } from '../src/types/observation.js';
import {
    AgentIdSchema,
    MessageIdSchema,
    MemberIdSchema,
} from '../src/public-types/conversation/schemas.js';

describe('conversationReducer thread lifecycle projection', () => {
    it('folds thread.closed and thread.archived with sorted thread ids', () => {
        const thread = { kind: 'thread' as const, id: 'b-thread' };
        const thread2 = { kind: 'thread' as const, id: 'a-thread' };
        const obs: Observation[] = [
            {
                source: 'conversation',
                payload: {
                    kind: 'thread.closed',
                    thread,
                    ts: '2026-01-01T00:00:00.000Z',
                    closedBy: 'agent-x' as never,
                    closedReason: 'explicit',
                    reasonText: 'bye',
                },
            } as Observation,
            {
                source: 'conversation',
                payload: {
                    kind: 'thread.archived',
                    thread,
                    ts: '2026-01-02T00:00:00.000Z',
                    archivedBy: 'agent-x' as never,
                },
            } as Observation,
            {
                source: 'conversation',
                payload: {
                    kind: 'thread.closed',
                    thread: thread2,
                    ts: '2026-01-01T01:00:00.000Z',
                    closedReason: 'ttl',
                },
            } as Observation,
        ];

        const p = reduceConversationProjection(undefined, obs);
        const ids = Object.keys(p.threads);
        expect(ids).toEqual(['a-thread', 'b-thread']);
        expect(p.threads['b-thread']?.status).toBe('archived');
        expect(p.threads['b-thread']?.closedReason).toBe('explicit');
        expect(p.threads['a-thread']?.closedReason).toBe('ttl');
    });

    it('records expiresAt from outbound.committed threadExpiresAt', () => {
        const thread = { kind: 'thread' as const, id: 'ttl-thread' };
        const a1 = AgentIdSchema.parse('agent-one');
        const a2 = AgentIdSchema.parse('agent-two');
        const obs: Observation[] = [
            {
                source: 'conversation',
                payload: {
                    kind: 'message.received',
                    message: {
                        id: MessageIdSchema.parse('msg-exp-1'),
                        conversation: thread,
                        senderAgentId: a1,
                        senderMemberId: MemberIdSchema.parse(a1),
                        recipientAgentId: a2,
                        recipientMemberId: MemberIdSchema.parse(a2),
                        speechAct: 'inform',
                        content: {},
                        sequenceNumber: 1,
                        ts: '2026-01-01T00:00:00.000Z',
                    },
                },
            } as Observation,
            {
                source: 'conversation',
                payload: {
                    kind: 'outbound.committed',
                    ref: thread,
                    messageId: MessageIdSchema.parse('msg-exp-1'),
                    sequenceNumber: 1,
                    deliveries: [
                        {
                            memberId: MemberIdSchema.parse(a2),
                            recipientAgentId: a2,
                            sessionId: 's2',
                            messageId: MessageIdSchema.parse('msg-exp-1'),
                            sequenceNumber: 1,
                            dedupeHit: false,
                        },
                    ],
                    threadExpiresAt: '2026-06-01T12:00:00.000Z',
                },
            } as Observation,
        ];
        const p = reduceConversationProjection(undefined, obs);
        expect(p.threads['ttl-thread']?.expiresAt).toBe('2026-06-01T12:00:00.000Z');
    });
});
