import { UnifiedMemoryService } from './UnifiedMemoryService.js';
import {
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    MemoryQueryResult,
    MemorySetOptions,
    GetManyInput,
    GetManyOptions,
    MemoryQueryOptions,
    RecognitionOptions,
    RecognitionResult,
    EnrichmentOptions,
    EnrichmentResult
} from '@a2arium/callagent-types';

/**
 * MLO-backed Semantic Memory Backend
 * 
 * Routes all semantic memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export class MLOSemanticBackend implements SemanticMemoryBackend {
    constructor(
        private unifiedMemory: UnifiedMemoryService,
        private underlyingAdapter?: any, // Optional underlying adapter for entity alignment
        private taskContext?: any // Task context for automatic injection
    ) { }

    async get<T>(key: string, opts?: { backend?: string }): Promise<T | null> {
        const result = await this.unifiedMemory.getSemanticMemory(key);
        return result as T | null;
    }

    async getMany<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>> {
        return this.unifiedMemory.getManySemanticMemory<T>(input, options);
    }

    async set<T>(key: string, value: T, opts?: MemorySetOptions): Promise<void> {
        // If entities are provided, use the underlying adapter directly to preserve entity alignment
        if (opts?.entities && this.underlyingAdapter?.set) {
            await this.underlyingAdapter.set(key, value, opts);
            return;
        }

        // Otherwise, go through MLO pipeline
        // Convert MemorySetOptions to namespace for backward compatibility
        // In the future, we can enhance UnifiedMemoryService to support full MemorySetOptions
        await this.unifiedMemory.setSemanticMemory(key, value, opts?.tags?.[0]);
    }

    async delete(key: string, opts?: { backend?: string }): Promise<void> {
        await this.unifiedMemory.deleteSemanticMemory(key);
    }

    async deleteMany(input: GetManyInput, options?: GetManyOptions): Promise<number> {
        return this.unifiedMemory.deleteManySemanticMemory(input, options);
    }

    // Entity alignment methods - delegate to the underlying adapter if available
    entities = {
        unlink: async (memoryKey: string, fieldPath: string): Promise<void> => {
            if (this.underlyingAdapter?.entities?.unlink) {
                return this.underlyingAdapter.entities.unlink(memoryKey, fieldPath);
            }
            throw new Error('Entity alignment not available - no underlying adapter with entity support');
        },
        realign: async (memoryKey: string, fieldPath: string, newEntityId: string): Promise<void> => {
            if (this.underlyingAdapter?.entities?.realign) {
                return this.underlyingAdapter.entities.realign(memoryKey, fieldPath, newEntityId);
            }
            throw new Error('Entity alignment not available - no underlying adapter with entity support');
        },
        stats: async (entityType?: string): Promise<{
            totalEntities: number;
            totalAlignments: number;
            entitiesByType: Record<string, number>;
        }> => {
            if (this.underlyingAdapter?.entities?.stats) {
                return this.underlyingAdapter.entities.stats(entityType);
            }
            throw new Error('Entity alignment not available - no underlying adapter with entity support');
        }
    };

    // Recognition and enrichment methods - delegate to the underlying adapter if available
    async recognize<T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>> {
        if (this.underlyingAdapter?.recognize) {
            // Automatically inject task context if not provided
            const enhancedOptions = {
                ...options,
                taskContext: options?.taskContext || this.taskContext
            };
            return this.underlyingAdapter.recognize(candidateData, enhancedOptions);
        }
        throw new Error('Recognition not available - no underlying adapter with recognition support');
    }

    async enrich<T>(key: string, additionalData: T[], options?: EnrichmentOptions): Promise<EnrichmentResult<T>> {
        if (this.underlyingAdapter?.enrich) {
            // Automatically inject task context if not provided
            const enhancedOptions = {
                ...options,
                taskContext: options?.taskContext || this.taskContext
            };
            return this.underlyingAdapter.enrich(key, additionalData, enhancedOptions);
        }
        throw new Error('Enrichment not available - no underlying adapter with enrichment support');
    }
}

/**
 * MLO-backed Episodic Memory Backend
 * 
 * Routes all episodic memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export class MLOEpisodicBackend implements EpisodicMemoryBackend {
    constructor(private unifiedMemory: UnifiedMemoryService) { }

    async append<T>(event: T, opts?: { backend?: string, tags?: string[] }): Promise<void> {
        await this.unifiedMemory.appendEpisodic(event);
    }

    async getEvents<T>(filter?: MemoryQueryOptions & { backend?: string }): Promise<Array<MemoryQueryResult<T>>> {
        return this.unifiedMemory.getEpisodicEvents<T>(filter);
    }

    async deleteEvent(id: string, opts?: { backend?: string }): Promise<void> {
        await this.unifiedMemory.deleteEpisodicEvent(id);
    }
}

/**
 * MLO-backed Embed Memory Backend
 * 
 * Routes all embed memory operations through the UnifiedMemoryService
 * to ensure they go through the 6-stage MLO pipeline.
 */
export class MLOEmbedBackend implements EmbedMemoryBackend {
    constructor(private unifiedMemory: UnifiedMemoryService) { }

    async upsert<T>(key: string, embedding: number[], value: T, opts?: { backend?: string }): Promise<void> {
        await this.unifiedMemory.upsertEmbedMemory(key, embedding, value);
    }

    async queryByVector<T>(vector: number[], opts?: { backend?: string, limit?: number }): Promise<Array<MemoryQueryResult<T>>> {
        return this.unifiedMemory.queryEmbedMemoryByVector<T>(vector, opts);
    }

    async delete(key: string, opts?: { backend?: string }): Promise<void> {
        await this.unifiedMemory.deleteEmbedMemory(key);
    }
} 