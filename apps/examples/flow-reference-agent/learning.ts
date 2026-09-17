import type { MentalState, MemoryReader, MemoryWriter } from '@a2arium/callagent-core';
import type { Intent } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';
import { applyObservation } from './reducers.js';

export function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    return applyObservation(prev, obs);
}
