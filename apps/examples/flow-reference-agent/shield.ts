import type { MentalState, MemoryReader, Intent, ShieldOutcome } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function shield(_m: MentalState<Sensory>, intent: Intent, _mem: MemoryReader): ShieldOutcome {
    return { action: 'pass', intent };
}
