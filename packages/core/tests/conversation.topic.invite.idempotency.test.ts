import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { wallClock } from '../src/internal/conversation/Clock.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('Topic invite idempotency', () => {
    const tenantId = 't-idem';
    const owner = 'owner-agent';
    const ownerSession = 'topic-topic-idem-1:owner-agent';

    const create = () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => ({
                tenantId,
                sessionId: `${threadId}:${recipientAgentId}`,
                agentId: recipientAgentId,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            clock: wallClock,
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });
        return { service, sessionManager };
    };

    it('same idempotencyKey returns same token and expiresAt without duplicating issued observations', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, ownerSession, owner, {
            topicId: 'topic-idem-1',
            members: [{ agentId: owner, role: 'owner' }],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') return;

        const first = await service.invite(tenantId, ownerSession, owner, {
            topic: created.topic,
            invitee: { agentId: 'peer-a', role: 'participant' },
            ttlSeconds: 3600,
            idempotencyKey: 'idem-invite-1',
        });
        expect(first.status).toBe('ok');
        if (first.status !== 'ok') return;

        const second = await service.invite(tenantId, ownerSession, owner, {
            topic: created.topic,
            invitee: { agentId: 'peer-a', role: 'participant' },
            ttlSeconds: 3600,
            idempotencyKey: 'idem-invite-1',
        });
        expect(second.status).toBe('ok');
        if (second.status !== 'ok') return;

        expect(second.token).toBe(first.token);
        expect(second.expiresAt).toBe(first.expiresAt);

        const loaded = await sessionManager.load(tenantId, ownerSession);
        const inbox = (loaded?.snapshot as { inbox?: { all?: Array<{ payload?: { kind?: string } }> } } | undefined)
            ?.inbox?.all ?? [];
        const issuedKinds = inbox.map((o) => o?.payload?.kind).filter((k): k is string => typeof k === 'string');
        const issuedCount = issuedKinds.filter((k) => k === 'topic.invite.issued').length;
        expect(issuedCount).toBe(1);
    });
});
