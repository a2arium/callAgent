import { WorkingVariables } from '../../../../../shared/types/workingMemory.js';
import { TaskContext } from '../../../../../shared/types/index.js';
/**
 * Extend context with full memory capabilities
 *
 * This function creates a UnifiedMemoryService instance and integrates it
 * with the TaskContext to provide comprehensive memory operations including:
 * - Working memory operations (goals, thoughts, decisions, variables)
 * - Semantic memory operations (backward compatible)
 * - Episodic memory operations (backward compatible)
 * - Unified recall/remember operations
 * - Direct MLO access
 */
export declare function extendContextWithMemory(baseContext: Record<string, unknown>, tenantId: string, agentId: string, agentConfig: unknown, existingSemanticAdapter?: unknown): Promise<TaskContext>;
/**
 * Legacy function name for backward compatibility
 * @deprecated Use extendContextWithMemory instead
 */
export declare function extendContextWithWorkingMemory(baseContext: Record<string, unknown>, workingMemory: unknown): Record<string, unknown>;
/**
 * Legacy function for creating working variables proxy
 * @deprecated Use extendContextWithMemory instead
 */
export declare function createLegacyWorkingVariablesProxy(wm: unknown): WorkingVariables;
