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
    if (obs.kind === 'user_message' && obs.text === 'go') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    userText: obs.text,
                    demoStage: 'want_run',
                },
            },
        };
    }
    return prev;
}
