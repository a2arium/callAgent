import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('Conversation persistence (in-memory store)', () => {
    const tenantId = 't-persist';
    const ownerSession = 'sess-owner';
    const parent = 'parent-agent';
    const child = 'child-agent';

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
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => null,
        });
        return { service, sessionManager };
    };

    it('lists messages in ascending sequence order', async () => {
        const { service, sessionManager } = create();
        const started = await service.startThread(tenantId, ownerSession, parent, {
            targetAgentId: child,
            conversationId: 'thread-seq-1',
            message: {
                senderAgentId: parent,
                speechAct: 'request',
                content: { a: 1 },
            },
        });
        const thread = started.thread;
        await service.send(tenantId, ownerSession, thread, {
            senderAgentId: parent,
            recipientAgentId: child,
            speechAct: 'inform',
            content: { a: 2 },
        });
        const rows = await sessionManager.listConversationMessages({
            tenantId,
            conversationId: thread.id,
        });
        expect(rows.map((r) => r.sequenceNumber)).toEqual([1, 2]);
    });

    it('returns the same sequence on idempotent replay lookup', async () => {
        const { service, sessionManager } = create();
        const started = await service.startThread(tenantId, ownerSession, parent, {
            targetAgentId: child,
            message: {
                senderAgentId: parent,
                speechAct: 'request',
                content: {},
            },
        });
        const thread = started.thread;
        await service.send(
            tenantId,
            ownerSession,
            thread,
            {
                senderAgentId: parent,
                recipientAgentId: child,
                speechAct: 'question',
                content: { q: 1 },
            },
            { idempotencyKey: 'idem-x' }
        );
        const found = await sessionManager.findConversationMessageByIdempotencyKey({
            tenantId,
            conversationId: thread.id,
            senderMemberId: parent,
            idempotencyKey: 'idem-x',
        });
        expect(found?.sequenceNumber).toBe(2);
    });

    it('startThread leaves one open thread and at least one persisted message', async () => {
        const { service, sessionManager } = create();
        const started = await service.startThread(tenantId, ownerSession, parent, {
            targetAgentId: child,
            conversationId: 'thread-atomic-1',
            message: {
                senderAgentId: parent,
                speechAct: 'request',
                content: { first: true },
            },
        });
        const thread = await sessionManager.getConversationThread({
            tenantId,
            conversationId: started.thread.id,
        });
        expect(thread?.status).toBe('open');
        const msgs = await sessionManager.listConversationMessages({
            tenantId,
            conversationId: started.thread.id,
        });
        expect(msgs.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects sends after the thread is closed', async () => {
        const { service } = create();
        const started = await service.startThread(tenantId, ownerSession, parent, {
            targetAgentId: child,
            message: {
                senderAgentId: parent,
                speechAct: 'request',
                content: {},
            },
        });
        const thread = started.thread;
        await service.close(tenantId, ownerSession, parent, thread);
        const receipt = await service.send(tenantId, ownerSession, thread, {
            senderAgentId: parent,
            recipientAgentId: child,
            speechAct: 'inform',
            content: {},
        });
        expect(receipt.status).toBe('rejected');
        if (receipt.status === 'rejected') {
            expect(receipt.error.type).toBe('ConversationClosed');
        }
    });
});
