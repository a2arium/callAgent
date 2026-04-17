import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { ThreadLifecycleSweeper } from '../src/internal/conversation/ThreadLifecycleSweeper.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('Thread TTL and sweeper', () => {
    const tenantId = 't-ttl';
    const owner = 'owner-a';
    const participant = 'participant-b';
    const ownerSessionId = 'owner-session';

    const routeTarget = (threadId: string, recipientAgentId: string) => ({
        tenantId,
        sessionId: `${threadId}:${recipientAgentId}`,
        agentId: recipientAgentId,
    });

    it('idle-reset: send extends expiresAt so early sweep does not close', async () => {
        let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
        const clock = { now: () => new Date(nowMs) };
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => routeTarget(threadId, recipientAgentId),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => 500,
            clock,
        });

        const started = await service.startThread(tenantId, ownerSessionId, owner, {
            targetAgentId: participant,
            message: {
                senderAgentId: owner,
                speechAct: 'request',
                content: { n: 1 },
            },
        });
        expect(started.receipt.status).toBe('accepted');
        if (started.receipt.status !== 'accepted') {
            return;
        }
        const thread = started.thread;
        nowMs += 100;
        const sendReceipt = await service.send(tenantId, ownerSessionId, thread, {
            senderAgentId: owner,
            recipientAgentId: participant,
            speechAct: 'inform',
            content: { ping: true },
        });
        expect(sendReceipt.status).toBe('accepted');

        const sweeper = new ThreadLifecycleSweeper(sessionManager, ({ threadId, recipientAgentId }) =>
            routeTarget(threadId, recipientAgentId)
        );
        nowMs += 401;
        const sweepAt501 = await sweeper.sweepTenant({
            tenantId,
            nowIso: new Date(nowMs).toISOString(),
            limit: 10,
            autoArchiveAfterMs: null,
        });
        expect(sweepAt501.expiredThreadIds).toEqual([]);

        const rowMid = await sessionManager.getConversationThread({ tenantId, conversationId: thread.id });
        expect(rowMid?.status).toBe('open');

        nowMs += 200;
        const sweepAt701 = await sweeper.sweepTenant({
            tenantId,
            nowIso: new Date(nowMs).toISOString(),
            limit: 10,
            autoArchiveAfterMs: null,
        });
        expect(sweepAt701.expiredThreadIds).toEqual([thread.id]);
        const rowClosed = await sessionManager.getConversationThread({ tenantId, conversationId: thread.id });
        expect(rowClosed?.status).toBe('closed');
        expect(rowClosed?.closeReason).toBe('ttl');
    });

    it('send after TTL close returns ThreadExpired', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => routeTarget(threadId, recipientAgentId),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => null,
        });
        const threadId = 'thr-exp-1';
        await sessionManager.createConversationThread({
            tenantId,
            conversationId: threadId,
            ownerAgentId: owner,
            participantAgentId: participant,
            expiresAt: '2020-01-01T00:00:00.000Z',
        });
        const sweeper = new ThreadLifecycleSweeper(sessionManager, ({ threadId: tid, recipientAgentId }) =>
            routeTarget(tid, recipientAgentId)
        );
        await sweeper.sweepTenant({
            tenantId,
            nowIso: '2026-01-01T00:00:00.000Z',
            limit: 10,
            autoArchiveAfterMs: null,
        });
        const sendReceipt = await service.send(
            tenantId,
            ownerSessionId,
            { kind: 'thread', id: threadId },
            {
                senderAgentId: owner,
                recipientAgentId: participant,
                speechAct: 'inform',
                content: { late: true },
            }
        );
        expect(sendReceipt.status).toBe('rejected');
        if (sendReceipt.status === 'rejected') {
            expect(sendReceipt.error.type).toBe('ThreadExpired');
        }
    });
});
