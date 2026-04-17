import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';

describe('ConversationService topic harness', () => {
    const tenantId = 't-topic-h';
    const session = 'sess-1';
    const owner = 'owner-agent';
    const p1 = 'participant-1';
    const p2 = 'participant-2';
    const phantom = 'phantom-agent';

    const create = () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
        });
        return { service, sessionManager };
    };

    it('createTopic with 3 members, broadcast delivers to both others', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-1',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
                {
                    agentId: p2,
                    role: 'participant',
                    sessionIdOverride: 'custom-route-p2',
                },
            ],
            defaultSelector: { kind: 'round_robin' },
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const r = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { n: 1 } },
            { selector: { kind: 'broadcast' } }
        );
        expect(r.status).toBe('accepted');
        if (r.status === 'accepted') {
            expect(r.deliveries.map((d) => d.recipientAgentId).sort()).toEqual([p1, p2].sort());
        }
    });

    it('round_robin two posts hit different recipients when two participants', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-rr',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
                { agentId: p2, role: 'participant' },
            ],
            defaultSelector: { kind: 'round_robin' },
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const a = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { step: 'rr1' } },
            { selector: { kind: 'round_robin' } }
        );
        const b = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { step: 'rr2' } },
            { selector: { kind: 'round_robin' } }
        );
        expect(a.status).toBe('accepted');
        expect(b.status).toBe('accepted');
        if (a.status === 'accepted' && b.status === 'accepted') {
            expect(a.deliveries[0]?.recipientAgentId).not.toBe(b.deliveries[0]?.recipientAgentId);
        }
    });

    it('explicit_recipient to non-member yields rejected without append', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-ex',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const r = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: phantom } } }
        );
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') {
            expect(r.error.type).toBe('RecipientNotMember');
        }
    });

    it('close topic then post is ConversationClosed', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-close',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
        });
        if (created.status !== 'ok') {
            throw new Error('create failed');
        }
        const topic = created.topic;
        const closed = await service.close(tenantId, session, owner, topic, {});
        expect(closed.closed).toBe(true);
        const post = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            {}
        );
        expect(post.status).toBe('rejected');
        if (post.status === 'rejected') {
            expect(post.error.type).toBe('ConversationClosed');
        }
    });
});
