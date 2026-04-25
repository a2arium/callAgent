import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { memberId } from '../src/public-types/conversation/index.js';

describe('topic multiplicity isolation', () => {
    it('routes outbound.committed to resolved sender seat session', async () => {
        const tenantId = 't-multi-iso';
        const owner = 'agent-a';
        const ownerSeat1Session = 'topic-seat-a1';
        const ownerSeat2Session = 'topic-seat-a2';
        const peer = 'agent-b';
        const peerSession = 'topic-seat-b';

        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => ({
                tenantId,
                sessionId: `${threadId}:${recipientAgentId}`,
                agentId: recipientAgentId,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });

        const created = await service.createTopic(tenantId, ownerSeat1Session, owner, {
            topicId: 'topic-multi-iso',
            members: [
                { agentId: owner, memberId: memberId('a#1'), role: 'owner', sessionIdOverride: ownerSeat1Session },
                { agentId: owner, memberId: memberId('a#2'), role: 'participant', sessionIdOverride: ownerSeat2Session },
                { agentId: peer, role: 'participant', sessionIdOverride: peerSession },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }

        const post = await service.post(
            tenantId,
            ownerSeat1Session,
            owner,
            created.topic,
            { senderAgentId: owner, senderMemberId: memberId('a#2'), speechAct: 'inform', content: { n: 1 } },
            { selector: { kind: 'broadcast' } }
        );
        expect(post.status).toBe('accepted');

        const seat1Snap = await sessionManager.load(tenantId, ownerSeat1Session);
        const seat2Snap = await sessionManager.load(tenantId, ownerSeat2Session);
        const peerSnap = await sessionManager.load(tenantId, peerSession);
        const seat1Kinds = ((seat1Snap?.snapshot as { inbox?: { current?: Array<{ payload?: { kind?: string } }> } } | undefined)?.inbox?.current ?? []).map(
            (o) => o.payload?.kind
        );
        const seat2Kinds = ((seat2Snap?.snapshot as { inbox?: { current?: Array<{ payload?: { kind?: string } }> } } | undefined)?.inbox?.current ?? []).map(
            (o) => o.payload?.kind
        );
        const peerTopicMessage = (
            (peerSnap?.snapshot as {
                inbox?: { current?: Array<{ payload?: { kind?: string; message?: { senderMemberId?: string } } }> };
            } | undefined)?.inbox?.current ?? []
        ).find((o) => o.payload?.kind === 'topic.message.received');

        expect(seat2Kinds).toContain('outbound.committed');
        expect(seat1Kinds).not.toContain('outbound.committed');
        expect(peerTopicMessage?.payload?.message?.senderMemberId).toBe('a#2');
    });

    it('preserves distinct senderMemberId for four seats sharing one agentId', async () => {
        const tenantId = 't-multi-four-seats';
        const ownerAgent = 'multi-agent-orchestrator-agent';
        const participantAgent = 'multi-agent-participant-agent';
        const ownerSession = 'topic-owner-seat';
        const utilSession = 'topic-util-seat';
        const fairSession = 'topic-fair-seat';
        const dutySession = 'topic-duty-seat';
        const pragSession = 'topic-prag-seat';

        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => ({
                tenantId,
                sessionId: `${threadId}:${recipientAgentId}`,
                agentId: recipientAgentId,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });

        const created = await service.createTopic(tenantId, ownerSession, ownerAgent, {
            topicId: 'topic-multi-four-seats',
            members: [
                {
                    agentId: ownerAgent,
                    memberId: memberId('orchestrator'),
                    role: 'owner',
                    sessionIdOverride: ownerSession,
                },
                {
                    agentId: participantAgent,
                    memberId: memberId('utilitarian'),
                    role: 'participant',
                    sessionIdOverride: utilSession,
                },
                {
                    agentId: participantAgent,
                    memberId: memberId('fairness'),
                    role: 'participant',
                    sessionIdOverride: fairSession,
                },
                {
                    agentId: participantAgent,
                    memberId: memberId('duty'),
                    role: 'participant',
                    sessionIdOverride: dutySession,
                },
                {
                    agentId: participantAgent,
                    memberId: memberId('pragmatist'),
                    role: 'participant',
                    sessionIdOverride: pragSession,
                },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }

        const seatIds = ['utilitarian', 'fairness', 'duty', 'pragmatist'] as const;
        const seatSessionById: Record<(typeof seatIds)[number], string> = {
            utilitarian: utilSession,
            fairness: fairSession,
            duty: dutySession,
            pragmatist: pragSession,
        };
        for (const seatId of seatIds) {
            const post = await service.post(
                tenantId,
                seatSessionById[seatId],
                participantAgent,
                created.topic,
                {
                    senderAgentId: participantAgent,
                    senderMemberId: memberId(seatId),
                    speechAct: 'answer',
                    content: { seatId },
                },
                { selector: { kind: 'broadcast' } }
            );
            expect(post.status).toBe('accepted');
        }

        const ownerSnap = await sessionManager.load(tenantId, ownerSession);
        const ownerInbox = (
            (ownerSnap?.snapshot as {
                inbox?: {
                    current?: Array<{
                        payload?: {
                            kind?: string;
                            message?: { senderMemberId?: string };
                        };
                    }>;
                };
            } | undefined)?.inbox?.current ?? []
        )
            .filter((o) => o.payload?.kind === 'topic.message.received')
            .map((o) => o.payload?.message?.senderMemberId)
            .filter((v): v is string => typeof v === 'string');

        expect(new Set(ownerInbox)).toEqual(new Set(seatIds));
    });
});

