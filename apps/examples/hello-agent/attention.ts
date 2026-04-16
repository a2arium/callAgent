import type { AttentionSignal, MentalState, EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

/** Minimal attention signal — replace with a real signal when needed. */
export function attention(
    _prev: MentalState<Sensory>,
    _env: EnvironmentState,
    _mem: MemoryReader
): AttentionSignal {
    return undefined as unknown as AttentionSignal;
}
