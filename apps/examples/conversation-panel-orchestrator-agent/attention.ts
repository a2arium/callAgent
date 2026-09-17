import type { AttentionSignal, EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function attention(
    _prev: MentalState<Sensory>,
    _env: EnvironmentState,
    _mem: MemoryReader
): AttentionSignal {
    return undefined as unknown as AttentionSignal;
}
