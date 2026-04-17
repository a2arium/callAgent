import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import type { Obs } from './types.js';
import {
    PANEL_ORCHESTRATOR_AGENT_ID,
    PANEL_TOPIC_ID_PREFIX,
    lensFromMemberIdString,
    routingMemberIdFromSessionId,
} from './constants.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const seatMemberId = routingMemberIdFromSessionId(env.sessionId);
    const myLens = seatMemberId ? lensFromMemberIdString(seatMemberId) : undefined;
    if (!myLens || !seatMemberId) {
        return { kind: 'idle' };
    }

    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        if (o.source !== 'conversation' || o.kind !== 'topic.message.received') {
            continue;
        }
        const payload = o.payload as {
            kind?: string;
            topic?: { id?: string };
            message?: {
                id?: string;
                sequenceNumber?: number;
                senderAgentId?: string;
                recipientAgentId?: string;
                recipientMemberId?: string;
                content?: { phase?: string; lens?: string; round?: number; prompt?: string };
            };
        };
        if (payload.kind !== 'topic.message.received' || !payload.topic || !payload.message) {
            continue;
        }
        const topicId = payload.topic.id;
        if (typeof topicId !== 'string' || !topicId.startsWith(PANEL_TOPIC_ID_PREFIX)) {
            continue;
        }
        const msg = payload.message;
        if (msg.senderAgentId !== PANEL_ORCHESTRATOR_AGENT_ID) {
            continue;
        }
        if (msg.content?.phase !== 'panel_turn') {
            continue;
        }
        const rmid = msg.recipientMemberId != null ? String(msg.recipientMemberId) : '';
        if (rmid !== seatMemberId) {
            continue;
        }
        if (msg.content.lens !== myLens) {
            continue;
        }
        const inboundMessageId = typeof msg.id === 'string' ? msg.id : `seq-${msg.sequenceNumber ?? 0}`;
        const round = typeof msg.content.round === 'number' ? msg.content.round : 0;
        const promptText = typeof msg.content.prompt === 'string' ? msg.content.prompt : '';
        return {
            kind: 'panel_prompt',
            topicId,
            seatMemberId,
            round,
            promptText,
            inboundMessageId,
            inboundSequence: msg.sequenceNumber ?? 0,
            lens: myLens,
        };
    }
    return { kind: 'idle' };
}
