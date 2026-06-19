import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { Attention, Sensory } from './types.js';

export function attention(
    _previous: MentalState<Sensory>,
    env: EnvironmentState,
    _memory: MemoryReader
): Attention {
    return {
        hasCurrentInput: env.inbox.current.length > 0,
    };
}
