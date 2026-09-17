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
        const activations: Array<{ kind: string; routingSessionId: string; recipientAgentId: string }> = [];
        const runtimeEvents: unknown[] = [];
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async (params) => {
                activations.push({
                    kind: params.kind,
                    routingSessionId: params.routingSessionId,
                    recipientAgentId: params.recipientAgentId,
                });
                return { ok: true };
            },
            publishRuntimeEvent: async ({ event }) => {
                runtimeEvents.push(event);
            },
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
            resolveWakeOnTopicMessage: () => true,
        });
        return { service, sessionManager, activations, runtimeEvents };
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

    it('publishes debug runtime events for topic post send and receive', async () => {
        const { service, runtimeEvents } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-runtime-1',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: p1, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') return;

        const result = await service.post(tenantId, session, owner, created.topic, {
            senderAgentId: owner,
            speechAct: 'inform',
            content: { text: 'hello topic' },
        });

        expect(result.status).toBe('accepted');
        expect(runtimeEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: expect.stringContaining(p1),
                type: 'conversation.message.received',
                visibility: 'debug',
                data: expect.objectContaining({
                    conversationId: 'topic-runtime-1',
                    kind: 'topic',
                    senderAgentId: owner,
                    recipientAgentId: p1,
                    speechAct: 'inform',
                }),
            }),
            expect.objectContaining({
                taskId: expect.stringContaining(owner),
                type: 'conversation.message.sent',
                visibility: 'debug',
                data: expect.objectContaining({
                    conversationId: 'topic-runtime-1',
                    kind: 'topic',
                    senderAgentId: owner,
                    speechAct: 'inform',
                }),
            }),
        ]));
    });

    it('marks topic delivery delivered only after recipient snapshot routing commits', async () => {
        const { service, sessionManager, activations } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-delivery-status',
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

        const posted = await service.post(
            tenantId,
            session,
            owner,
            created.topic,
            { senderAgentId: owner, speechAct: 'inform', content: { status: 'committed' } },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
        );

        expect(posted.status).toBe('accepted');
        if (posted.status !== 'accepted') {
            return;
        }
        const deliveryRows = await sessionManager.listConversationMessageDeliveries({
            tenantId,
            conversationId: created.topic.id,
            sequenceNumber: posted.deliveries[0]!.sequenceNumber,
        });
        expect(deliveryRows).toHaveLength(1);
        expect(deliveryRows[0]?.status).toBe('delivered');
        expect(activations).toContainEqual({
            kind: 'topic',
            routingSessionId: `topic-${created.topic.id}:${p1}`,
            recipientAgentId: p1,
        });
    });

    it('persists topic deliveries with canonical top-level observation kind', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-envelope-kind',
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

        const posted = await service.post(
            tenantId,
            session,
            owner,
            created.topic,
            {
                senderAgentId: owner,
                speechAct: 'request',
                content: { body: { phase: 'suite_phase_request', phaseId: 'integrated_review' } },
            },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
        );
        expect(posted.status).toBe('accepted');

        const participantSnapshot = await sessionManager.load(
            tenantId,
            `topic-${created.topic.id}:${p1}`
        );
        const current = ((participantSnapshot?.snapshot as any)?.inbox?.current ?? []) as any[];
        const delivered = current.find((obs) => obs?.payload?.kind === 'topic.message.received');
        expect(delivered).toMatchObject({
            source: 'conversation',
            kind: 'topic.message.received',
            payload: {
                kind: 'topic.message.received',
                message: {
                    recipientMemberId: p1,
                    content: { body: { phase: 'suite_phase_request', phaseId: 'integrated_review' } },
                },
            },
        });
    });

    it('does not await cross-session topic wake activation before returning post receipt', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        let activationStarted = false;
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => {
                activationStarted = true;
                await new Promise(() => undefined);
                return { ok: true };
            },
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
            resolveWakeOnTopicMessage: () => true,
        });
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-nonblocking-wake',
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

        const posted = await Promise.race([
            service.post(
                tenantId,
                session,
                owner,
                created.topic,
                { senderAgentId: owner, speechAct: 'inform', content: { status: 'wake-hangs' } },
                { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
            ),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('post blocked on wake')), 50)),
        ]);

        expect(posted.status).toBe('accepted');
        expect(activationStarted).toBe(true);
        const deliveryRows = await sessionManager.listConversationMessageDeliveries({
            tenantId,
            conversationId: created.topic.id,
            sequenceNumber: posted.status === 'accepted' ? posted.deliveries[0]!.sequenceNumber : -1,
        });
        expect(deliveryRows[0]?.status).toBe('delivered');
    });

    it('marks topic delivery dead-lettered when recipient snapshot routing fails', async () => {
        const { service, sessionManager } = create();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-h-delivery-dead-letter',
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

        const originalSave = sessionManager.saveSnapshot.bind(sessionManager);
        (sessionManager as unknown as { saveSnapshot: typeof sessionManager.saveSnapshot }).saveSnapshot = async (params) => {
            if (params.sessionId === `topic-${created.topic.id}:${p1}`) {
                throw new Error('ROUTE_FAILED');
            }
            return originalSave(params);
        };

        await expect(
            service.post(
                tenantId,
                session,
                owner,
                created.topic,
                { senderAgentId: owner, speechAct: 'inform', content: { status: 'route-fails' } },
                { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: p1 } } }
            )
        ).rejects.toThrow('ROUTE_FAILED');

        const messages = await sessionManager.listConversationMessages({ tenantId, conversationId: created.topic.id });
        const deliveryRows = await sessionManager.listConversationMessageDeliveries({
            tenantId,
            conversationId: created.topic.id,
            sequenceNumber: messages[0]!.sequenceNumber,
        });
        expect(deliveryRows).toHaveLength(1);
        expect(deliveryRows[0]?.status).toBe('dead-lettered');
        expect(deliveryRows[0]?.error?.message).toBe('ROUTE_FAILED');
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

    it('ConversationRouter retries delivery injection when an active turn saves the session first', async () => {
        const { sessionManager } = create();
        const sessionId = 'topic-topic-router-race:orchestrator';
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId: owner,
            expectedWmVersion: BigInt(0),
            snapshot: {
                inbox: { current: [], all: [] },
                meta: { agentId: owner },
            },
        });

        const originalSave = sessionManager.saveSnapshot.bind(sessionManager);
        let firstRouteSave = true;
        (sessionManager as unknown as { saveSnapshot: typeof sessionManager.saveSnapshot }).saveSnapshot = async (params) => {
            if (firstRouteSave) {
                firstRouteSave = false;
                await originalSave({
                    tenantId: params.tenantId,
                    sessionId: params.sessionId,
                    agentId: params.agentId,
                    expectedWmVersion: params.expectedWmVersion,
                    snapshot: {
                        inbox: { current: [], all: [] },
                        meta: { agentId: params.agentId, activeTurnSavedFirst: true },
                    },
                });
                throw new Error('CAS_MISMATCH');
            }
            return originalSave(params);
        };

        const router = new ConversationRouter(sessionManager);
        const observation = {
            source: 'conversation',
            payload: {
                kind: 'topic.message.received',
                message: {
                    id: 'msg-router-race',
                    conversation: { kind: 'topic', id: 'topic-router-race' },
                    senderAgentId: p1,
                    senderMemberId: 'participant-1',
                    recipientAgentId: owner,
                    recipientMemberId: 'orchestrator',
                    speechAct: 'inform',
                    content: { phase: 'triage_critique_reply' },
                    sequenceNumber: 10,
                    ts: new Date().toISOString(),
                },
                topic: { kind: 'topic', id: 'topic-router-race' },
                selector: {
                    kind: 'explicit_recipient',
                    recipient: { by: 'memberId', memberId: 'orchestrator' },
                },
                recipient: { memberId: 'orchestrator', agentId: owner },
            },
        } as Observation;

        await router.routeObservation({
            tenantId,
            sessionId,
            agentId: owner,
            observation,
        });

        const loaded = await sessionManager.load(tenantId, sessionId);
        const snapshot = (loaded?.snapshot as Record<string, unknown>) ?? {};
        const inbox = normalizeObservationInbox(snapshot.inbox);
        expect((snapshot.meta as { activeTurnSavedFirst?: boolean } | undefined)?.activeTurnSavedFirst).toBe(true);
        expect(
            inbox.current.some(
                (obs) => (obs as { payload?: { message?: { id?: string } } }).payload?.message?.id === 'msg-router-race'
            )
        ).toBe(true);
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
