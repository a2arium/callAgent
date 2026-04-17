import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ThreadLifecycleSweeper } from '../src/internal/conversation/ThreadLifecycleSweeper.js';

describe('ThreadLifecycleSweeper', () => {
    const tenantId = 't-sweep';
    const owner = 'owner-a';
    const participant = 'participant-b';

    it('expires open threads past expiresAt and archives closed threads after grace', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const threadId = 'thread-expire-1';
        await sessionManager.createConversationThread({
            tenantId,
            conversationId: threadId,
            ownerAgentId: owner,
            participantAgentId: participant,
            expiresAt: '2020-01-01T00:00:00.000Z',
        });

        const routeTargetForThread = ({
            threadId: tid,
            recipientAgentId,
        }: {
            tenantId: string;
            threadId: string;
            recipientAgentId: string;
        }) => ({
            tenantId,
            sessionId: `${tid}:${recipientAgentId}`,
            agentId: recipientAgentId,
        });

        const sweeper = new ThreadLifecycleSweeper(sessionManager, routeTargetForThread);
        const nowIso = '2026-01-01T00:00:00.000Z';
        const expireOnly = await sweeper.sweepTenant({
            tenantId,
            nowIso,
            limit: 10,
            autoArchiveAfterMs: null,
        });
        expect(expireOnly.expiredThreadIds).toEqual([threadId]);
        expect(expireOnly.archivedThreadIds).toEqual([]);
        const afterExpire = await sessionManager.getConversationThread({ tenantId, conversationId: threadId });
        expect(afterExpire?.status).toBe('closed');
        expect(afterExpire?.closeReason).toBe('ttl');

        const withArchive = await sweeper.sweepTenant({
            tenantId,
            nowIso: '2026-06-01T00:00:00.000Z',
            limit: 10,
            autoArchiveAfterMs: 1,
        });
        expect(withArchive.archivedThreadIds).toEqual([threadId]);
        const afterArchive = await sessionManager.getConversationThread({ tenantId, conversationId: threadId });
        expect(afterArchive?.status).toBe('archived');
    });
});
