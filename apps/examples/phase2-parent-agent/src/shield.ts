import type { Intent, MemoryReader, MentalState, ShieldOutcome } from '@a2arium/callagent-core';
import type { ParentSensory } from './types.js';

export function shield(
    _state: MentalState<ParentSensory>,
    intent: Intent,
    _memory: MemoryReader
): ShieldOutcome {
    return { action: 'pass', intent };
}
