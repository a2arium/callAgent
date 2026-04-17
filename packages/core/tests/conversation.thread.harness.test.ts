import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('ConversationService thread primitives', () => {
    const tenantId = 't-1';
    const ownerSessionId = 'owner-session';
    const senderAgentId = 'parent-agent';
    const recipientAgentId = 'child-agent';

    const createService = () => {
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

    it('starts thread and accepts initial message', async () => {
        const { service } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'analyze' },
            },
        });
        expect(started.thread.kind).toBe('thread');
        expect(started.receipt.status).toBe('accepted');
    });

    it('dedupes by idempotency key', async () => {
        const { service } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'first' },
            },
        });
        const thread = started.thread;
        const one = await service.send(
            tenantId,
            ownerSessionId,
            thread,
            {
                senderAgentId,
                recipientAgentId,
                speechAct: 'question',
                content: { text: 'follow-up' },
            },
            { idempotencyKey: 'idem-1' }
        );
        const two = await service.send(
            tenantId,
            ownerSessionId,
            thread,
            {
                senderAgentId,
                recipientAgentId,
                speechAct: 'question',
                content: { text: 'follow-up' },
            },
            { idempotencyKey: 'idem-1' }
        );
        expect(one.status).toBe('accepted');
        expect(two.status).toBe('accepted');
        if (one.status === 'accepted' && two.status === 'accepted') {
            expect(two.dedupeHit).toBe(true);
            expect(two.sequenceNumber).toBe(one.sequenceNumber);
        }
    });

    it('rejects on inflight when queueMode reject', async () => {
        const { service, sessionManager } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'first' },
            },
        });
        const thread = started.thread;
        const recipientSessionId = `${thread.id}:${recipientAgentId}`;
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: recipientSessionId,
            agentId: recipientAgentId,
            expectedWmVersion: BigInt(1),
            snapshot: {
                pending: {
                    inputs: { token: { prompt: 'x' } },
                    tools: {},
                    children: {},
                    groups: {},
                },
            },
        });
        const receipt = await service.send(tenantId, ownerSessionId, thread, {
            senderAgentId,
            recipientAgentId,
            speechAct: 'question',
            content: { text: 'blocked while inflight' },
        });
        expect(receipt.status).toBe('rejected');
    });
});

