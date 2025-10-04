import { IMemory, MemoryRegistry, SemanticMemoryBackend, WorkingMemoryBackend } from '@a2arium/callagent-types';
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
/**
 * Configuration options for memory registry
 */
export interface MemoryRegistryConfig {
    /** Database configuration */
    database?: {
        /** Database connection URL */
        url?: string;
        /** Pre-configured Prisma client */
        prismaClient?: any;
    };
    /** Custom memory adapters */
    adapters?: {
        /** Custom semantic memory adapter */
        semantic?: SemanticMemoryBackend;
        /** Custom working memory adapter */
        working?: WorkingMemoryBackend;
    };
}
export declare function createMemoryRegistry(tenantId?: string, agentId?: string, taskContext?: any, config?: MemoryRegistryConfig): Promise<ExtendedIMemory>;
