import type { MentalState } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';

export function applyObservation(prev: MentalState<Sensory>, obs: Obs): MentalState<Sensory> {
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
