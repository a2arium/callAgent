import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const s = m.memory?.sensory;
    if (s?.wantVoice === true && s.lens && s.inboundMessageId && s.activeTopicId) {
        return {
            kind: 'internal',
            intent: 'panel_persona_voice',
            data: {
                topicId: s.activeTopicId,
                lens: s.lens,
                promptText: s.promptText ?? '',
                inboundMessageId: s.inboundMessageId,
                inboundSequence: s.inboundSequence ?? 0,
                round: s.promptRound ?? 0,
                seatMemberId: s.seatMemberId ?? '',
            },
        };
    }
    return { kind: 'wait' };
}
