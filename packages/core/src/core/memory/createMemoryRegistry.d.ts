import { IMemory, MemoryRegistry, WorkingMemoryBackend } from '@callagent/types';
/**
 * Extended IMemory interface that includes working memory
 */
export type ExtendedIMemory = IMemory & {
    working: MemoryRegistry<WorkingMemoryBackend>;
};
/**
 * Create a comprehensive memory registry with all memory types
 * Routes all operations through MLO while maintaining backward compatibility
 */
export declare function createMemoryRegistry(tenantId?: string, agentId?: string, taskContext?: any): Promise<ExtendedIMemory>;
