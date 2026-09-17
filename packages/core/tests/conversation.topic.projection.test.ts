import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ConversationService } from '../src/internal/conversation/ConversationService.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import {
    ensureBuiltinTopicProjectionsRegistered,
    topicTranscriptProjectionToken,
} from '../src/internal/conversation/builtinTopicProjections.js';

const DEFAULT_TOPIC_STOP = [{ kind: 'timeout' as const, afterMs: 86_400_000 }];

describe('Topic shared projections (5.4d)', () => {
    const tenantId = 't-tproj';
    const session = 'sess-tproj';
    const owner = 'owner-tproj';
    const peer = 'peer-tproj';

    beforeAll(() => {
        ensureBuiltinTopicProjectionsRegistered();
    });

    const createService = () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        return new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: (_agentId: string) => null,
        });
    };

    it('readProjection folds topic.transcript from the message log', async () => {
        const service = createService();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-tproj-1',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: peer, role: 'participant' },
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
            { senderAgentId: owner, speechAct: 'inform', content: { text: 'hello' } },
            { selector: { kind: 'broadcast' } }
        );
        expect(post.status).toBe('accepted');

        const receipt = await service.readProjection(tenantId, session, owner, topic, topicTranscriptProjectionToken);
        expect(receipt.status).toBe('ok');
        if (receipt.status !== 'ok') {
            return;
        }
        type Line = { sequenceNumber: number; speechAct: string; text: string };
        const lines = (receipt.state as { lines: Line[] }).lines;
        expect(lines).toHaveLength(1);
        expect(lines[0].speechAct).toBe('inform');
        expect(lines[0].text).toContain('hello');
        expect(receipt.asOfSequence).toBe(lines[0].sequenceNumber);
    });

    it('readProjection rejects unknown projection names', async () => {
        const service = createService();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-tproj-2',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: peer, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const topic = created.topic;
        const receipt = await service.readProjection(tenantId, session, owner, topic, {
            projectionName: 'no.such.projection',
        });
        expect(receipt.status).toBe('rejected');
        if (receipt.status === 'rejected') {
            expect(receipt.error.type).toBe('ProjectionNotRegistered');
        }
    });

    it('appendSignal appends a signal row visible to topic.transcript', async () => {
        const service = createService();
        const created = await service.createTopic(tenantId, session, owner, {
            topicId: 'topic-tproj-3',
            members: [
                { agentId: owner, role: 'owner' },
                { agentId: peer, role: 'participant' },
            ],
            defaultSelector: { kind: 'broadcast' },
            stopPolicies: DEFAULT_TOPIC_STOP,
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
            { signalType: 'topic.backpressure.changed', payload: { level: 'high' } },
            { selector: { kind: 'broadcast' } }
        );
        expect(sig.status).toBe('accepted');

        const receipt = await service.readProjection(tenantId, session, owner, topic, topicTranscriptProjectionToken);
        expect(receipt.status).toBe('ok');
        if (receipt.status !== 'ok') {
            return;
        }
        type Line = { speechAct: string; text: string };
        const lines = (receipt.state as { lines: Line[] }).lines;
        expect(lines).toHaveLength(1);
        expect(lines[0].speechAct).toBe('signal');
        expect(lines[0].text).toContain('topic.backpressure.changed');
    });
});
