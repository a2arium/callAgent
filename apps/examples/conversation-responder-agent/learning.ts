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
    if (obs.kind === 'reply_sent') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    replied: true,
                },
            },
        };
    }
    if (obs.kind === 'conversation') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    latestThreadId: obs.threadId,
                    latestSequence: obs.sequenceNumber,
                    latestInboundMessageId: obs.inboundMessageId,
                    replied: false,
                },
            },
        };
    }
    return prev;
}
