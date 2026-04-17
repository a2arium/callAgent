import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { Sensory } from './types.js';
import { DEMO_CHILD_AGENT_ID, DEMO_THREAD_ID, DEMO_TOPIC_PHASE2_ID } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-reference-agent' });

function recipientRoutingSessionId(threadId: string, recipientAgentId: string): string {
    return `${threadId}:${recipientAgentId}`;
}

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const stage = m.memory?.sensory?.demoStage;
    const sensory = m.memory?.sensory;
    if (stage === 'want_open') {
        return { kind: 'internal', intent: 'conversation_demo_open', data: { childAgentId: DEMO_CHILD_AGENT_ID } };
    }
    if (stage === 'want_followup') {
        return {
            kind: 'internal',
            intent: 'conversation_demo_follow_up',
            data: { threadId: DEMO_THREAD_ID, childAgentId: DEMO_CHILD_AGENT_ID },
        };
    }
    if (stage === 'want_phase2') {
        return {
            kind: 'internal',
            intent: 'conversation_phase2_run',
            data: { childAgentId: DEMO_CHILD_AGENT_ID },
        };
    }
    if (stage === 'want_phase2_close') {
        const topicView = m.memory?.conversation?.topics?.[DEMO_TOPIC_PHASE2_ID];
        if (topicView?.status === 'closed') {
            return { kind: 'wait' };
        }
        return { kind: 'internal', intent: 'conversation_phase2_close', data: {} };
    }
    if (stage === 'done') {
        log.info('conversation.initiator_complete', {
            threadId: DEMO_THREAD_ID,
            recipientRoutingSessionId: recipientRoutingSessionId(DEMO_THREAD_ID, DEMO_CHILD_AGENT_ID),
            initiatorOutboundOpenMessageId: sensory?.openOutboundMessageId,
            initiatorOutboundOpenSequence: sensory?.openOutboundSequence,
            initiatorObservedInboundMessageId: sensory?.lastInboundMessageId,
            initiatorObservedInboundSequence: sensory?.lastInboundSequence,
        });
        return {
            kind: 'complete',
            result: {
                threadId: DEMO_THREAD_ID,
                awaitingReply: false,
                exchangeWitness: {
                    tenantIdForAudit: 'default',
                    threadId: DEMO_THREAD_ID,
                    recipientRoutingSessionId: recipientRoutingSessionId(DEMO_THREAD_ID, DEMO_CHILD_AGENT_ID),
                    initiatorOutboundOpenMessageId: sensory?.openOutboundMessageId,
                    initiatorOutboundOpenSequence: sensory?.openOutboundSequence,
                    initiatorObservedInboundMessageId: sensory?.lastInboundMessageId,
                    initiatorObservedInboundSequence: sensory?.lastInboundSequence,
                    persistedMessagesCheck: {
                        workspace: '@a2arium/callagent-memory-sql',
                        script: 'print-conversation',
                        tenantId: 'default',
                        conversationId: DEMO_THREAD_ID,
                    },
                },
            },
        };
    }
    return { kind: 'wait' };
}
