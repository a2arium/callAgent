import type { TaskContext, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../../types.js';

/** Placeholder LLM effect handler for non-trivial scaffolded agents. */
export async function runLlmEffect(
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<{ ok: true }> {
    return { ok: true };
}
