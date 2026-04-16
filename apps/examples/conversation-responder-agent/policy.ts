import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

/** Must match `conversation-reference-agent` card `name` — recipient of our reply. */
const INITIATOR_AGENT_ID = 'conversation-reference-agent' as const;

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const s = m.memory?.sensory;
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
