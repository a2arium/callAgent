import type { EnvironmentState, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { ParentAttention, ParentSensory } from './types.js';

export function attention(
    _previous: MentalState<ParentSensory>,
    env: EnvironmentState,
    _memory: MemoryReader
): ParentAttention {
    return { hasCurrentInput: env.inbox.current.length > 0 };
}
