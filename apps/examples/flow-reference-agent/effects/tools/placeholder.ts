import type { TaskContext, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../../types.js';

/** Placeholder tool effect handler for non-trivial scaffolded agents. */
export async function runToolEffect(
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<{ ok: true }> {
    return { ok: true };
}
