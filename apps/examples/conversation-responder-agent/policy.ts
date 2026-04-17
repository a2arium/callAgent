import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';
import { DEMO_TOPIC_PHASE2_ID } from './types.js';

/** Must match `conversation-reference-agent` card `name` — recipient of our thread reply. */
const INITIATOR_AGENT_ID = 'conversation-reference-agent' as const;

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const s = m.memory?.sensory;

    if (s?.topicLeft === true) {
        return {
            kind: 'complete',
            result: { acknowledged: true, topicLeft: true },
        };
    }

    if (s?.latestThreadId && s.replied === true) {
        return {
            kind: 'complete',
            result: {
                acknowledged: true,
                threadId: s.latestThreadId,
                sequence: s.latestSequence,
            },
        };
    }

    if (s?.wantLeaveTopic === true && s.topicJoined === true && !s.topicLeft) {
        const topicView = m.memory?.conversation?.topics?.[DEMO_TOPIC_PHASE2_ID];
        if (topicView?.status === 'closed') {
            return { kind: 'wait' };
        }
        return { kind: 'internal', intent: 'conversation_responder_topic_leave', data: {} };
    }

    if (s?.pendingInviteToken && s.topicJoined !== true) {
        return {
            kind: 'internal',
            intent: 'conversation_responder_topic_join',
            data: { token: s.pendingInviteToken },
        };
    }

    if (s?.topicMessageSeq !== undefined && s.topicReplied === false) {
        return { kind: 'internal', intent: 'conversation_responder_topic_reply', data: {} };
    }

    if (s?.latestThreadId && s.replied !== true) {
        return {
            kind: 'internal',
            intent: 'conversation_responder_reply',
            data: {
                threadId: s.latestThreadId,
                initiatorAgentId: INITIATOR_AGENT_ID,
                inboundMessageId: s.latestInboundMessageId,
                inboundSequence: s.latestSequence,
            },
        };
    }
    return { kind: 'wait' };
}
