import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { TopicLifecycleSweeper } from '../src/internal/conversation/TopicLifecycleSweeper.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('TopicLifecycleSweeper', () => {
    const tenantId = 't-topic-sweep';
    const session = 'sess-owner';
    const owner = 'owner-a';
    const peer = 'peer-b';

    it('archives closed topics after autoArchiveAfterMs', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => null,
        });
        const topicId = 'topic-sweep-1';
        const created = await service.createTopic(tenantId, session, owner, {
            topicId,
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: peer, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const closed = await service.close(tenantId, session, owner, topic, {});
        expect(closed.status).toBe('ok');

        const row = await sessionManager.getConversationTopic({ tenantId, conversationId: topicId });
        expect(row?.status).toBe('closed');
        expect(row?.closedAt).toBeDefined();

        const sweeper = new TopicLifecycleSweeper(sessionManager);
        const sweepAt = new Date(Date.parse(row!.closedAt!) + 120_000).toISOString();
        const r = await sweeper.sweepTenant({
            tenantId,
            nowIso: sweepAt,
            limit: 10,
            autoArchiveAfterMs: 60_000,
        });
        expect(r.archivedTopicIds).toEqual([topicId]);
        const after = await sessionManager.getConversationTopic({ tenantId, conversationId: topicId });
        expect(after?.status).toBe('archived');
        expect(after?.archivedAt).toBeDefined();
    });

    it('does nothing when autoArchiveAfterMs is null', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const sweeper = new TopicLifecycleSweeper(sessionManager);
        const r = await sweeper.sweepTenant({
            tenantId: 't',
            nowIso: '2026-01-01T00:00:00.000Z',
            limit: 10,
            autoArchiveAfterMs: null,
        });
        expect(r.archivedTopicIds).toEqual([]);
    });
});
