import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { reconstructFanoutReceiptFromDeliveries } from '../src/internal/conversation/fanoutReplay.js';
import type { ConversationMessageDeliveryRecord } from '@a2arium/callagent-memory-engine';

describe('Topic fan-out idempotency replay', () => {
    const tenantId = 't-replay';
    const session = 'sess-1';
    const owner = 'owner-agent';
    const peer = 'peer-agent';

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

    it('reconstructs accepted receipt when all deliveries succeeded', () => {
        const topic = { kind: 'topic' as const, id: 'topic-1' };
        const message = {
            tenantId,
            conversationId: topic.id,
            sequenceNumber: 1,
            messageId: 'm1',
            senderAgentId: owner,
            recipientAgentId: null,
            conversationKind: 'topic' as const,
            selectorKind: 'broadcast',
            speechAct: 'inform',
            payload: { content: {} },
            createdAt: new Date().toISOString(),
        };
        const deliveries: ConversationMessageDeliveryRecord[] = [
            {
                tenantId,
                conversationId: topic.id,
                sequenceNumber: 1,
                memberId: 'member-peer',
                recipientAgentId: peer,
                sessionId: `${topic.id}:${peer}`,
                dedupeHit: false,
                status: 'delivered',
                error: null,
                queuePosition: null,
            },
        ];
        const r = reconstructFanoutReceiptFromDeliveries(topic, message, deliveries);
        expect(r.status).toBe('accepted');
        if (r.status === 'accepted') {
            expect(r.deliveries).toHaveLength(1);
            expect(r.deliveries[0]!.dedupeHit).toBe(true);
        }
    });

    it('reconstructs partial receipt from mixed delivery rows', () => {
        const topic = { kind: 'topic' as const, id: 'topic-2' };
        const message = {
            tenantId,
            conversationId: topic.id,
            sequenceNumber: 1,
            messageId: 'm1',
            senderAgentId: owner,
            recipientAgentId: null,
            conversationKind: 'topic' as const,
            selectorKind: 'broadcast',
            speechAct: 'inform',
            payload: { content: {} },
            createdAt: new Date().toISOString(),
        };
        const deliveries: ConversationMessageDeliveryRecord[] = [
            {
                tenantId,
                conversationId: topic.id,
                sequenceNumber: 1,
                memberId: 'member-a1',
                recipientAgentId: 'a1',
                sessionId: 's1',
                dedupeHit: false,
                status: 'delivered',
                error: null,
                queuePosition: null,
            },
            {
                tenantId,
                conversationId: topic.id,
                sequenceNumber: 1,
                memberId: 'member-a2',
                recipientAgentId: 'a2',
                sessionId: 's2',
                dedupeHit: false,
                status: 'rejected',
                error: { type: 'ThreadBusy', message: 'busy' },
                queuePosition: null,
            },
        ];
        const r = reconstructFanoutReceiptFromDeliveries(topic, message, deliveries);
        expect(r.status).toBe('partial');
        if (r.status === 'partial') {
            expect(r.accepted).toHaveLength(1);
            expect(r.rejected).toHaveLength(1);
            expect(r.rejected[0]!.error.type).toBe('ThreadBusy');
        }
    });

    it('createTopic returns rejected when owner is not the caller', async () => {
        const { service } = create();
        const r = await service.createTopic(tenantId, session, owner, {
            members: [
                { agentId: peer, role: 'owner' },
                { agentId: owner, role: 'participant' },
            ],
        });
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') {
            expect(r.error.type).toBe('Forbidden');
        }
    });
});
