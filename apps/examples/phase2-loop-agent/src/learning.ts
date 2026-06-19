import type { Intent, MemoryReader, MemoryWriter, MentalState } from '@a2arium/callagent-core';
import { reduceObservation } from './reducers.js';
import type { Phase2Observation, Sensory } from './types.js';

export function learning(
    previous: MentalState<Sensory>,
    _previousAction: Intent | undefined,
    observation: Phase2Observation,
    _memory: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    return reduceObservation(previous, observation);
}
