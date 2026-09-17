import type { MentalState, MemoryReader, MemoryWriter, Intent } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';

export function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    if (obs.kind === 'idle') {
        return prev;
    }
    if (obs.kind === 'panel_prompt') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    activeTopicId: obs.topicId,
                    seatMemberId: obs.seatMemberId,
                    wantVoice: true,
                    promptRound: obs.round,
                    promptText: obs.promptText,
                    inboundMessageId: obs.inboundMessageId,
                    inboundSequence: obs.inboundSequence,
                    lens: obs.lens,
                },
            },
        };
    }
    return prev;
}
