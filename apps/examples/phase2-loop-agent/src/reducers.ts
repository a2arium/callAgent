import type { MentalState } from '@a2arium/callagent-core';
import type { Phase2Observation, Sensory } from './types.js';

export function reduceObservation(
    previous: MentalState<Sensory>,
    observation: Phase2Observation
): MentalState<Sensory> {
    if (observation.kind === 'runtime/no_input') {
        return previous;
    }

    const sensory = previous.memory?.sensory ?? { askedForDetail: false };
    return {
        ...previous,
        memory: {
            ...previous.memory,
            sensory: {
                ...sensory,
                latestUserText: observation.text,
            },
        },
    };
}

export function markDetailRequested(state: MentalState<Sensory>): void {
    const sensory = state.memory?.sensory ?? { askedForDetail: false };
    state.memory = {
        ...state.memory,
        sensory: {
            ...sensory,
            askedForDetail: true,
        },
    };
}
