import { LLMConfig } from '../../shared/types/LLMTypes.js';
import { LLMCallerAdapter } from './LLMCallerAdapter.js';
import type { TaskContext } from '../../shared/types/index.js';

/**
 * Creates an LLM instance for a task context
 * This factory automatically wires up the usage tracking between the LLM and the TaskContext
 */
export function createLLMForTask(config: LLMConfig, ctx: TaskContext): LLMCallerAdapter {
    // Create the adapter with the recordUsage function from the context
    return new LLMCallerAdapter(
        config,
        (cost: number | { cost: number }) => ctx.recordUsage(cost as any)
    );
} 