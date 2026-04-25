import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { ConversationRouter } from '../src/internal/conversation/ConversationRouter.js';
import { conversationInboxDeliveryKey } from '../src/loop/conversationInboxIdentity.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import type { Observation } from '../src/types/observation.js';

const DEFAULT_TOPIC_STOP = [{ kind: 'timeout' as const, afterMs: 86_400_000 }];

describe('ConversationService topic harness', () => {
    const tenantId = 't-topic-h';
    const session = 'sess-1';
    const owner = 'owner-agent';
    const p1 = 'participant-1';
    const p2 = 'participant-2';
    const phantom = 'phantom-agent';

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

    it('createTopic with 3 members, broadcast delivers to both others', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-1',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
                {
                    agentId: p2,
                    role: 'participant',
                    sessionIdOverride: 'custom-route-p2',
                },
            ],
            defaultSelector: { kind: 'round_robin' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const r = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { n: 1 } },
            { selector: { kind: 'broadcast' } }
        );
        expect(r.status).toBe('accepted');
        if (r.status === 'accepted') {
            expect(r.deliveries.map((d) => d.recipientAgentId).sort()).toEqual([p1, p2].sort());
        }
    });

    it('round_robin two posts hit different recipients when two participants', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-rr',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
                { agentId: p2, role: 'participant' },
            ],
            defaultSelector: { kind: 'round_robin' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const a = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { step: 'rr1' } },
            { selector: { kind: 'round_robin' } }
        );
        const b = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { step: 'rr2' } },
            { selector: { kind: 'round_robin' } }
        );
        expect(a.status).toBe('accepted');
        expect(b.status).toBe('accepted');
        if (a.status === 'accepted' && b.status === 'accepted') {
            expect(a.deliveries[0]?.recipientAgentId).not.toBe(b.deliveries[0]?.recipientAgentId);
        }
    });

    it('explicit_recipient to non-member yields rejected without append', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-ex',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const r = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: phantom } } }
        );
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') {
            expect(r.error.type).toBe('RecipientNotMember');
        }
    });

    it('ConversationRouter is idempotent when the same topic delivery is routed again', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-dup-r',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
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
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
        );
        expect(post.status).toBe('accepted');
        if (post.status !== 'accepted') {
            return;
        }
        const sessionId = `topic-${topic.id}:participant-1`;
        const loaded = await sessionManager.load(tenantId, sessionId);
        const snapshot = (loaded?.snapshot as { inbox?: unknown } | null | undefined) ?? {};
        const inbox0 = normalizeObservationInbox(snapshot.inbox);
        const allLen0 = inbox0.all.length;
        const topicReceived = inbox0.all.find(
            (o) => (o as { payload?: { kind?: string } }).payload?.kind === 'topic.message.received'
        ) as Observation | undefined;
        expect(topicReceived).toBeDefined();
        if (topicReceived === undefined) {
            return;
        }
        const router = new ConversationRouter(sessionManager);
        await router.routeObservation({
            tenantId,
            sessionId,
            agentId: p1,
            observation: topicReceived,
        });
        const afterDup = await sessionManager.load(tenantId, sessionId);
        const inbox1 = normalizeObservationInbox(
            (afterDup?.snapshot as { inbox?: unknown } | null | undefined)?.inbox
        );
        expect(inbox1.all.length).toBe(allLen0);
    });

    it('ConversationRouter removes consumed stale current deliveries before routing a later topic message', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-stale-r',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const first = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { phase: 'initial' } },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
        );
        expect(first.status).toBe('accepted');
        if (first.status !== 'accepted') {
            return;
        }
        const sessionId = `topic-${topic.id}:participant-1`;
        const loaded = await sessionManager.load(tenantId, sessionId);
        const baseSnapshot = (loaded?.snapshot as Record<string, unknown> | undefined) ?? {};
        const inbox0 = normalizeObservationInbox(baseSnapshot.inbox);
        const stale = inbox0.current.find(
            (o) => (o as { payload?: { kind?: string } }).payload?.kind === 'topic.message.received'
        ) as Observation | undefined;
        expect(stale).toBeDefined();
        if (stale === undefined || loaded === null) {
            return;
        }
        const staleKey = conversationInboxDeliveryKey(stale);
        expect(staleKey).toBeDefined();
        if (staleKey === undefined) {
            return;
        }
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId: p1,
            expectedWmVersion: loaded.wmVersion,
            snapshot: {
                ...baseSnapshot,
                inbox: {
                    ...inbox0,
                    current: [stale],
                },
                meta: {
                    ...((baseSnapshot as { meta?: Record<string, unknown> }).meta ?? {}),
                    conversationConsumedDeliveryKeys: [staleKey],
                },
            },
        });
        const second = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: { phase: 'critique' } },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
        );
        expect(second.status).toBe('accepted');
        const afterSecond = await sessionManager.load(tenantId, sessionId);
        const inbox1 = normalizeObservationInbox(
            (afterSecond?.snapshot as { inbox?: unknown } | null | undefined)?.inbox
        );
        const currentKeys = inbox1.current
            .map((obs) => conversationInboxDeliveryKey(obs as Observation))
            .filter((key): key is string => key !== undefined);
        expect(currentKeys).not.toContain(staleKey);
        expect(currentKeys).toHaveLength(1);
    });

    it('close topic then post is ConversationClosed', async () => {
        const { service } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-close',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        if (created.status !== 'ok') {
            throw new Error('create failed');
        }
        const topic = created.topic;
        const closed = await service.close(tenantId, session, owner, topic, {});
        expect(closed.status).toBe('ok');
        if (closed.status === 'ok') {
            expect(closed.closed).toBe(true);
        }
        const post = await service.post(
            tenantId,
            session,
            owner,
            topic,
            { senderAgentId: owner, speechAct: 'inform', content: {} },
            {}
        );
        expect(post.status).toBe('rejected');
        if (post.status === 'rejected') {
            expect(post.error.type).toBe('ConversationClosed');
        }
    });
});
