import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { memberId } from '../src/public-types/conversation/index.js';

describe('topic multiplicity namespace safety', () => {
    it('does not fall back from memberId lookup to agentId', async () => {
        const tenantId = 't-multi-namespace';
        const owner = 'owner';
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => ({
                tenantId,
                sessionId: `${threadId}:${recipientAgentId}`,
                agentId: recipientAgentId,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });

        const created = await service.createTopic(tenantId, 'sess-owner', owner, {
            topicId: 'topic-multi-namespace',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: 'agent-b', memberId: memberId('b#1'), role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }

        const bad = await service.post(
            tenantId,
            'sess-owner',
            owner,
            created.topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: memberId('agent-b') } } }
        );

        expect(bad.status).toBe('rejected');
        if (bad.status === 'rejected') {
            expect(bad.error.type).toBe('RecipientNotMember');
        }
    });
});

