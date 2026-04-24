import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { createStopPolicyRegistry } from '../src/internal/conversation/StopPolicyRegistry.js';

describe('TopicStopPolicy', () => {
    const tenantId = 't-stop';
    const session = 'sess-owner';
    const owner = 'owner-agent';
    const p1 = 'participant-1';

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
            resolveThreadTtlMs: (_agentId: string) => null,
        });
        return { service, sessionManager };
    };

    it('maxTurns closes the topic after the configured number of messages', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-stop-max',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'maxTurns', n: 1 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const post = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { n: 1 } },
            { selector: { kind: 'broadcast' } }
        );
        expect(post.status).toBe('accepted');
        const row = await sessionManager.getConversationTopic({ tenantId, conversationId: topic.id });
        expect(row?.status).toBe('closed');
    });

    it('custom stop policy uses registry and can stop the topic', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const registry = createStopPolicyRegistry();
        registry.register({
            policyId: 'always-stop',
            evaluate: () => ({ kind: 'stop', reason: 'custom' }),
        });
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
            stopPolicyRegistry: registry,
        });
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-stop-custom',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'custom', policyId: 'always-stop' }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            { selector: { kind: 'broadcast' } }
        );
        const row = await sessionManager.getConversationTopic({ tenantId, conversationId: topic.id });
        expect(row?.status).toBe('closed');
    });

    it('signalBased closes the topic when appendSignal uses signalType in message content', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-stop-signal',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [
                {
                    kind: 'signalBased',
                    signals: ['x-example.signal-stop'],
                    requiredCount: 1,
                },
            ],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const sig = await service.appendSignal(
            tenantId,
            session,
            owner,
            topic,
            { signalType: 'x-example.signal-stop', payload: { ok: true } },
            { selector: { kind: 'broadcast' } }
        );
        expect(sig.status).toBe('accepted');
        const row = await sessionManager.getConversationTopic({ tenantId, conversationId: topic.id });
        expect(row?.status).toBe('closed');
    });
});
