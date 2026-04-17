import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('ConversationService thread lifecycle (close / archive)', () => {
    const tenantId = 't-lc';
    const ownerSessionId = 'owner-s';
    const senderAgentId = 'parent-agent';
    const recipientAgentId = 'child-agent';

    const createService = () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId:
                    recipient === senderAgentId ? ownerSessionId : `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => null,
        });
        return { service, sessionManager };
    };

    const loadInboxKinds = async (sessionManager: SessionManager, sessionId: string) => {
        const loaded = await sessionManager.load(tenantId, sessionId);
        const inbox = (loaded?.snapshot as { inbox?: { all?: { source?: string; kind?: string; payload?: { kind?: string } }[] } })
            ?.inbox;
        return (inbox?.all ?? []).map((o) => (o.source === 'conversation' ? o.payload?.kind : o.kind));
    };

    it('close(thread) emits thread.closed to both participants', async () => {
        const { service, sessionManager } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'x' },
            },
        });
        expect(started.receipt.status).toBe('accepted');
        if (started.receipt.status !== 'accepted') {
            return;
        }
        const thread = started.thread;
        await service.close(tenantId, ownerSessionId, senderAgentId, thread, { reason: 'done' });

        const ownerKinds = await loadInboxKinds(sessionManager, ownerSessionId);
        const participantKinds = await loadInboxKinds(sessionManager, `${thread.id}:${recipientAgentId}`);
        expect(ownerKinds.filter((k) => k === 'thread.closed').length).toBeGreaterThanOrEqual(1);
        expect(participantKinds.filter((k) => k === 'thread.closed').length).toBeGreaterThanOrEqual(1);
    });

    it('close(thread, { archiveAfter: true }) emits thread.archived', async () => {
        const { service, sessionManager } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'x' },
            },
        });
        expect(started.receipt.status).toBe('accepted');
        if (started.receipt.status !== 'accepted') {
            return;
        }
        const thread = started.thread;
        const receipt = await service.close(tenantId, ownerSessionId, senderAgentId, thread, {
            reason: 'done',
            archiveAfter: true,
        });
        expect(receipt.archived).toBe(true);

        const ownerKinds = await loadInboxKinds(sessionManager, ownerSessionId);
        expect(ownerKinds.filter((k) => k === 'thread.archived').length).toBeGreaterThanOrEqual(1);
    });

    it('archive(open thread) throws ThreadNotClosed', async () => {
        const { service } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'x' },
            },
        });
        expect(started.receipt.status).toBe('accepted');
        if (started.receipt.status !== 'accepted') {
            return;
        }
        await expect(
            service.archive(tenantId, ownerSessionId, senderAgentId, started.thread, {})
        ).rejects.toThrow('ThreadNotClosed');
    });

    it('close(topic, { archiveAfter: true }) throws ArchiveUnsupportedForTopics', async () => {
        const { service } = createService();
        const created = await service.createTopic(tenantId, ownerSessionId, senderAgentId, {
            topicId: 'topic-arch-test',
            members: [{ agentId: senderAgentId, role: 'owner', sessionIdOverride: ownerSessionId }],
            defaultSelector: { kind: 'broadcast' },
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        await expect(
            service.close(tenantId, ownerSessionId, senderAgentId, created.topic, { archiveAfter: true })
        ).rejects.toThrow('ArchiveUnsupportedForTopics');
    });

    it('send on closed thread returns ConversationClosed', async () => {
        const { service } = createService();
        const started = await service.startThread(tenantId, ownerSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { task: 'x' },
            },
        });
        expect(started.receipt.status).toBe('accepted');
        if (started.receipt.status !== 'accepted') {
            return;
        }
        const thread = started.thread;
        await service.close(tenantId, ownerSessionId, senderAgentId, thread, {});
        const sendReceipt = await service.send(tenantId, ownerSessionId, thread, {
            senderAgentId,
            recipientAgentId,
            speechAct: 'inform',
            content: { text: 'late' },
        });
        expect(sendReceipt.status).toBe('rejected');
        if (sendReceipt.status === 'rejected') {
            expect(sendReceipt.error.type).toBe('ConversationClosed');
        }
    });
});
