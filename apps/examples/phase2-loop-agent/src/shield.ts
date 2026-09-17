import type { Intent, MemoryReader, MentalState, ShieldOutcome } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function shield(
    _state: MentalState<Sensory>,
    intent: Intent,
    _memory: MemoryReader
): ShieldOutcome {
    return { action: 'pass', intent };
}
