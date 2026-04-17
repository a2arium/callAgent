import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('@a2arium/conversation-responder-agent — golden', () => {
    it('sends a reply then completes when conversation message arrives', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        await harness.seedConversationThread({
            conversationId: 'thread-conv-ref-1',
            ownerAgentId: 'conversation-reference-agent',
            participantAgentId: 'conversation-responder-agent',
        });

        harness.injectObservation({
            source: 'conversation',
            kind: 'message.received',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'msg-responder-1',
                    conversation: { kind: 'thread', id: 'thread-conv-ref-1' },
                    senderAgentId: 'conversation-reference-agent',
                    recipientAgentId: 'conversation-responder-agent',
                    recipientMemberId: 'conversation-responder-agent',
                    speechAct: 'request',
                    content: { hello: true },
                    sequenceNumber: 1,
                    ts: new Date().toISOString(),
                },
            },
        });

        await harness.runTurn();

        const t1 = harness.lastTrace();
        expect(['continue', 'complete']).toContain(t1.transition?.kind);
        expect(t1.conversation?.id).toBe('thread-conv-ref-1');
        expect(t1.incomingMessages?.[0]?.id).toBe('msg-responder-1');
        expect(t1.outgoingMessages?.length).toBeGreaterThanOrEqual(1);

        await harness.runTurn();

        const t2 = harness.lastTrace();
        expect(t2.transition?.kind).toBe('complete');
    });

    it('sends a distinct reply for each inbound message id (separate idempotency buckets)', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        await harness.seedConversationThread({
            conversationId: 'thread-conv-ref-2',
            ownerAgentId: 'conversation-reference-agent',
            participantAgentId: 'conversation-responder-agent',
        });

        const mkInbound = (id: string, sequenceNumber: number) =>
            harness.injectObservation({
                source: 'conversation',
                kind: 'message.received',
                payload: {
                    kind: 'message.received',
                    message: {
                        id,
                        conversation: { kind: 'thread', id: 'thread-conv-ref-2' },
                        senderAgentId: 'conversation-reference-agent',
                        recipientAgentId: 'conversation-responder-agent',
                        recipientMemberId: 'conversation-responder-agent',
                        speechAct: 'request',
                        content: { hello: true },
                        sequenceNumber,
                        ts: new Date().toISOString(),
                    },
                },
            });

        mkInbound('msg-inbound-a', 1);
        await harness.runTurn();
        expect(['continue', 'complete']).toContain(harness.lastTrace().transition?.kind);
        const firstOutboundId = harness.lastTrace().outgoingMessages?.[0]?.id;

        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('complete');

        mkInbound('msg-inbound-b', 2);
        await harness.runTurn();
        expect(['continue', 'complete']).toContain(harness.lastTrace().transition?.kind);
        const secondOutboundId = harness.lastTrace().outgoingMessages?.[0]?.id;
        expect(secondOutboundId).toBeDefined();
        expect(secondOutboundId).not.toBe(firstOutboundId);

        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('complete');
    });
});
