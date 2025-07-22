import { UnifiedMemoryService } from './UnifiedMemoryService.js';
import { SemanticMemoryBackend, EpisodicMemoryBackend, EmbedMemoryBackend, MemoryQueryResult, MemorySetOptions, GetManyInput, GetManyOptions, MemoryQueryOptions, RecognitionOptions, RecognitionResult, EnrichmentOptions, EnrichmentResult } from '@a2arium/callagent-types';
/**
 * MLO-backed Semantic Memory Backend
 *
 * Routes all semantic memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export declare class MLOSemanticBackend implements SemanticMemoryBackend {
    private unifiedMemory;
    private underlyingAdapter?;
    private taskContext?;
    constructor(unifiedMemory: UnifiedMemoryService, underlyingAdapter?: any | undefined, // Optional underlying adapter for entity alignment
    taskContext?: any | undefined);
    get<T>(key: string, opts?: {
        backend?: string;
    }): Promise<T | null>;
    getMany<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>>;
    set<T>(key: string, value: T, opts?: MemorySetOptions): Promise<void>;
    delete(key: string, opts?: {
        backend?: string;
    }): Promise<void>;
    deleteMany(input: GetManyInput, options?: GetManyOptions): Promise<number>;
    entities: {
        unlink: (memoryKey: string, fieldPath: string) => Promise<void>;
        realign: (memoryKey: string, fieldPath: string, newEntityId: string) => Promise<void>;
        stats: (entityType?: string) => Promise<{
            totalEntities: number;
            totalAlignments: number;
            entitiesByType: Record<string, number>;
        }>;
    };
    recognize<T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>>;
    enrich<T>(key: string, additionalData: T[], options?: EnrichmentOptions): Promise<EnrichmentResult<T>>;
}
/**
 * MLO-backed Episodic Memory Backend
 *
 * Routes all episodic memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export declare class MLOEpisodicBackend implements EpisodicMemoryBackend {
    private unifiedMemory;
    constructor(unifiedMemory: UnifiedMemoryService);
    append<T>(event: T, opts?: {
        backend?: string;
        tags?: string[];
    }): Promise<void>;
    getEvents<T>(filter?: MemoryQueryOptions & {
        backend?: string;
    }): Promise<Array<MemoryQueryResult<T>>>;
    deleteEvent(id: string, opts?: {
        backend?: string;
    }): Promise<void>;
}
/**
 * MLO-backed Embed Memory Backend
 *
 * Routes all embed memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export declare class MLOEmbedBackend implements EmbedMemoryBackend {
    private unifiedMemory;
    constructor(unifiedMemory: UnifiedMemoryService);
    upsert<T>(key: string, embedding: number[], value: T, opts?: {
        backend?: string;
    }): Promise<void>;
    queryByVector<T>(vector: number[], opts?: {
        backend?: string;
        limit?: number;
    }): Promise<Array<MemoryQueryResult<T>>>;
    delete(key: string, opts?: {
        backend?: string;
    }): Promise<void>;
}
