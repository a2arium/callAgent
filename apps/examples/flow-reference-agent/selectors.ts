import type { MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

/** Decision-ready view for Policy — keep reads out of deep nesting. */
export function readPolicyView(m: MentalState<Sensory>, _mem: MemoryReader): { latestUserText?: string } {
    return { latestUserText: m.memory?.sensory?.latestUserText };
}
