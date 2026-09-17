import type { Intent, MemoryReader, MemoryWriter, MentalState } from '@a2arium/callagent-core';
import type { ParentObservation, ParentSensory } from './types.js';

export function learning(
    previous: MentalState<ParentSensory>,
    _previousAction: Intent | undefined,
    observation: ParentObservation,
    _memory: MemoryReader,
    _writer: MemoryWriter
): MentalState<ParentSensory> {
    if (observation.kind === 'user/input_provided') {
        return {
            ...previous,
            memory: {
                ...previous.memory,
                sensory: {
                    ...previous.memory.sensory,
                    latestUserText: observation.text,
                },
            },
        };
    }
    if (observation.kind === 'child/completed') {
        return {
            ...previous,
            memory: {
                ...previous.memory,
                sensory: {
                    ...previous.memory.sensory,
                    childResult: observation.result,
                },
            },
        };
    }
    return previous;
}
