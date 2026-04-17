import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
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
        });

        const created = await service.createTopic(tenantId, ownerSeat1Session, owner, {
            topicId: 'topic-multi-iso',
            members: [
                { agentId: owner, memberId: memberId('a#1'), role: 'owner', sessionIdOverride: ownerSeat1Session },
                { agentId: owner, memberId: memberId('a#2'), role: 'participant', sessionIdOverride: ownerSeat2Session },
                { agentId: peer, role: 'participant', sessionIdOverride: peerSession },
            ],
            defaultSelector: { kind: 'broadcast' },
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
        const seat1Kinds = ((seat1Snap?.snapshot as { inbox?: { current?: Array<{ payload?: { kind?: string } }> } } | undefined)?.inbox?.current ?? []).map(
            (o) => o.payload?.kind
        );
        const seat2Kinds = ((seat2Snap?.snapshot as { inbox?: { current?: Array<{ payload?: { kind?: string } }> } } | undefined)?.inbox?.current ?? []).map(
            (o) => o.payload?.kind
        );

        expect(seat2Kinds).toContain('outbound.committed');
        expect(seat1Kinds).not.toContain('outbound.committed');
    });
});

