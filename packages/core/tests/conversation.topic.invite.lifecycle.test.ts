import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { createBusEvent } from '../src/eventbus/busEventHelpers.js';
import { v7 as uuidv7 } from 'uuid';
import { InviteDeliveryCoordinator } from '../src/internal/conversation/InviteDeliveryCoordinator.js';
import { InviteSweeper } from '../src/internal/conversation/InviteSweeper.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';

describe('Topic invite lifecycle', () => {
    const tenantId = 't-invite-lifecycle';
    const owner = 'owner-agent';
    const invitee = 'invitee-agent';
    const ownerSession = 'topic-topic-invite-1:owner-agent';

    const readInboxKinds = async (
        sessionManager: SessionManager,
        sessionId: string
    ): Promise<string[]> => {
        const loaded = await sessionManager.load(tenantId, sessionId);
        const inbox = (loaded?.snapshot as { inbox?: { all?: Array<{ payload?: { kind?: string } }> } } | undefined)
            ?.inbox?.all ?? [];
        return inbox
            .map((o) => o?.payload?.kind)
            .filter((k): k is string => typeof k === 'string');
    };

    const waitFor = async (fn: () => Promise<boolean>, timeoutMs: number = 1500): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (await fn()) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Timed out waiting for condition');
    };

    const createRuntime = async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const bus = createInMemoryEventBus();
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId }) => ({
                tenantId,
                sessionId: `${threadId}:${recipientAgentId}`,
                agentId: recipientAgentId,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            publishConversationEvent: async (channel, event) => {
                await bus.publish(
                    createBusEvent({
                        channel,
                        cloud: {
                            id: uuidv7(),
                            type: channel,
                            source: '/conversation/events',
                            time: new Date().toISOString(),
                            datacontenttype: 'application/json',
                            data: event,
                        },
                    })
                );
            },
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });
        const coordinator = new InviteDeliveryCoordinator(sessionManager, bus, async () => ({ ok: true }));
        await coordinator.start();
        const sweeper = new InviteSweeper(sessionManager);
        return { service, sessionManager, coordinator, sweeper };
    };

    it('invite emits issued and coordinator delivers received', async () => {
        const { service, sessionManager } = await createRuntime();
        const created = await service.createTopic(tenantId, ownerSession, owner, {
            topicId: 'topic-invite-1',
            members: [
                { agentId: owner, role: 'owner' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') return;

        const inviteReceipt = await service.invite(tenantId, ownerSession, owner, {
            topic: created.topic,
            invitee: { agentId: invitee, role: 'participant' },
            ttlSeconds: 600,
        });
        expect(inviteReceipt.status).toBe('ok');

        const ownerKinds = await readInboxKinds(sessionManager, ownerSession);
        expect(ownerKinds).toContain('topic.invite.issued');

        await waitFor(async () => {
            const inviteeKinds = await readInboxKinds(sessionManager, `agent-inbox:${invitee}`);
            return inviteeKinds.includes('topic.invite.received');
        });
        const inviteeKinds = await readInboxKinds(sessionManager, `agent-inbox:${invitee}`);
        expect(inviteeKinds).toContain('topic.invite.received');
    });

    it('expired sweep emits topic.invite.expired to inviter seat', async () => {
        const { service, sessionManager, sweeper } = await createRuntime();
        const created = await service.createTopic(tenantId, ownerSession, owner, {
            topicId: 'topic-invite-expire',
            members: [{ agentId: owner, role: 'owner' }],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') return;

        const inviteReceipt = await service.invite(tenantId, ownerSession, owner, {
            topic: created.topic,
            invitee: { agentId: invitee, role: 'participant' },
            ttlSeconds: 1,
        });
        expect(inviteReceipt.status).toBe('ok');
        if (inviteReceipt.status !== 'ok') return;

        const expired = await sweeper.runExpirySweep({
            tenantId,
            nowIso: '2100-01-01T00:00:00.000Z',
            limit: 100,
        });
        expect(expired.length).toBeGreaterThanOrEqual(1);

        const ownerSeats = await sessionManager.listConversationTopicMembersByAgent({
            tenantId,
            conversationId: created.topic.id,
            agentId: owner,
            activeOnly: true,
        });
        const inviterSessionId = ownerSeats[0]?.sessionId ?? ownerSession;
        const ownerKinds = await readInboxKinds(sessionManager, inviterSessionId);
        expect(ownerKinds).toContain('topic.invite.expired');
    });
});

