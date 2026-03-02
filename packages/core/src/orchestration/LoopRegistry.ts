import type { TaskContext } from '../shared/types/index.js';

/**
 * Shared registry for active loop contexts.
 * This is stored in a separate file to avoid circular dependencies
 * between TaskEngine and TaskExecutor.
 */
export class LoopRegistry {
    /**
     * Active loop contexts indexed by taskId.
     * Used by handleToolCompleted to inject results into running loops.
     */
    static __activeLoopContexts: Map<string, TaskContext> = new Map();
}
