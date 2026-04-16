import type { MentalState, MemoryReader, MemoryWriter } from '@a2arium/callagent-core';
import type { Intent } from '@a2arium/callagent-core';
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
    return {
        ...prev,
        memory: {
            ...prev.memory,
            sensory: {
                ...prev.memory.sensory,
                latestUserText: obs.text,
            },
        },
    };
}
