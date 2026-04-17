import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { CorrelationIdSchema } from '../src/public-types/conversation/schemas.js';

describe('Conversation blocking timeout', () => {
    const tenantId = 't-to';
    const ownerSessionId = 'owner-s';
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
        return { service };
    };

    it('startThread blocking + timeoutMs yields ConversationTimeout when no reply', async () => {
        const { service } = createService();
        const corr = CorrelationIdSchema.parse('corr-block-1');
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            awaitMode: 'blocking',
            timeoutMs: 80,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'block' },
                correlationId: corr,
            },
        });
        expect(started.receipt.status).toBe('rejected');
        if (started.receipt.status === 'rejected') {
            expect(started.receipt.error.type).toBe('ConversationTimeout');
        }
    }, 10_000);

    it('deferred startThread ignores timeoutMs for wait semantics', async () => {
        const { service } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            awaitMode: 'deferred',
            timeoutMs: 1,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'defer' },
            },
        });
        expect(started.receipt.status).toBe('accepted');
    });
});
