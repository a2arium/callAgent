import { ISelectiveForgetter } from '../../interfaces/ISelectiveForgetter.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@a2arium/callagent-utils';

export class TimeDecayForgetter implements ISelectiveForgetter {
    readonly stageName = 'derivation' as const;
    readonly componentName = 'forgetting' as const;
    readonly stageNumber = 3;

    private logger = logger.createLogger({ prefix: 'TimeDecayForgetter' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private stats = {
        totalItemsProcessed: 0,
        itemsForgotten: 0,
        itemsRetained: 0,
        itemsMerged: 0,
        averageDecayScore: 0,
        forgettingReasons: {} as Record<string, number>,
    };

    private maxAgeMs: number;
    private enabled: boolean;
    private placeholder: boolean;

    constructor(config?: {
        maxAgeMs?: number;
        enabled?: boolean;
        placeholder?: boolean;
    }) {
        this.maxAgeMs = config?.maxAgeMs || 24 * 60 * 60 * 1000; // 24h default
        this.enabled = config?.enabled ?? true;
        this.placeholder = config?.placeholder ?? true;
    }

    /**
     * PHASE 1: Simple time-based forgetting
     *   - Compute `age = now − timestamp`. If age > maxAge (default 24h), drop item.
     *
     * FUTURE (Phase 2+):
     *   - SimilarityDedupe: use a vector index (Pinecone or FAISS) to find near-duplicates 
     *     in working memory and merge or drop.  
     *   - RelevanceBasedForgetter: score each item's relevance to current goal (via LLM 
     *     embedding similarity) and drop those below threshold.  
     *   - Use "access frequency" heuristics: drop items not accessed in last N calls.  
     *   - Libraries & examples:
     *       • Pinecone Deduplication (https://docs.pinecone.io/docs/indexing).  
     *       • FAISS clustering + threshold (https://github.com/facebookresearch/faiss).  
     *       • LangChain's "PruneMemory" patterns (https://js.langchain.com/docs/use_cases/memory).  
     *
     * Usage for advanced forgetting:
     *   "forgetting": "SimilarityDedupe"
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.stats.totalItemsProcessed++;

        try {
            if (!this.enabled) {
                this.stats.itemsRetained++;
                return item;
            }

            const age = Date.now() - new Date(item.metadata.timestamp).getTime();
            const decayScore = age / this.maxAgeMs;

            // Update average decay score
            this.stats.averageDecayScore =
                (this.stats.averageDecayScore * (this.stats.totalItemsProcessed - 1) + decayScore) /
                this.stats.totalItemsProcessed;

            if (age > this.maxAgeMs) {
                // Drop item due to age
                this.stats.itemsForgotten++;
                this.stats.forgettingReasons['time_decay'] =
                    (this.stats.forgettingReasons['time_decay'] || 0) + 1;
                this.metrics.itemsDropped++;

                this.logger.debug('Item forgotten due to age', {
                    itemId: item.id,
                    age: age,
                    maxAge: this.maxAgeMs
                });

                this.metrics.processingTimeMs += Date.now() - startTime;
                return null;
            }

            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            this.stats.itemsRetained++;
            this.metrics.processingTimeMs += Date.now() - startTime;
            this.metrics.lastProcessedAt = new Date().toISOString();

            return item;
        } catch (error) {
            this.logger.error('Error in forgetting processing', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    async shouldForget(
        item: MemoryItem<unknown>,
        criteria?: {
            maxAge?: number;
            relevanceThreshold?: number;
            accessFrequency?: number;
        }
    ): Promise<{
        shouldForget: boolean;
        reason: string;
        confidence: number;
    }> {
        const age = Date.now() - new Date(item.metadata.timestamp).getTime();
        const maxAge = criteria?.maxAge || this.maxAgeMs;

        if (age > maxAge) {
            return {
                shouldForget: true,
                reason: 'time_decay',
                confidence: Math.min(age / maxAge, 1.0)
            };
        }

        return {
            shouldForget: false,
            reason: 'within_time_limit',
            confidence: 1.0 - (age / maxAge)
        };
    }

    async forgetByPattern(
        items: MemoryItem<unknown>[],
        pattern: {
            type: 'similarity' | 'frequency' | 'relevance';
            threshold: number;
            maxItems?: number;
        }
    ): Promise<MemoryItem<unknown>[]> {
        // Phase 1: Simple implementation
        if (pattern.type === 'frequency') {
            // Keep only the most recent items
            const maxItems = pattern.maxItems || Math.floor(items.length * (1 - pattern.threshold));
            return items
                .sort((a, b) => new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime())
                .slice(0, maxItems);
        }

        // For other patterns, return all items (placeholder)
        return items;
    }

    async calculateDecayScore(
        item: MemoryItem<unknown>,
        currentTime?: Date
    ): Promise<{
        decayScore: number;
        timeDecay: number;
        importanceBoost: number;
        shouldForget: boolean;
        reasoning: string;
    }> {
        const now = currentTime || new Date();
        const age = now.getTime() - new Date(item.metadata.timestamp).getTime();
        const timeDecay = age / this.maxAgeMs;
        const importanceBoost = 0; // Placeholder
        const decayScore = Math.min(timeDecay, 1.0);

        return {
            decayScore,
            timeDecay,
            importanceBoost,
            shouldForget: decayScore >= 1.0,
            reasoning: decayScore >= 1.0 ? 'Item exceeded maximum age' : 'Item within time limit'
        };
    }

    async findSimilarItems(
        item: MemoryItem<unknown>,
        candidateItems: MemoryItem<unknown>[],
        similarityThreshold?: number
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        similarity: number;
        shouldMerge: boolean;
        shouldRemove: boolean;
    }>> {
        // Phase 1: Placeholder implementation
        return candidateItems.map(candidate => ({
            item: candidate,
            similarity: 0.5, // Placeholder
            shouldMerge: false,
            shouldRemove: false
        }));
    }

    async preserveImportant(
        items: MemoryItem<unknown>[],
        preservationCriteria?: string[]
    ): Promise<MemoryItem<unknown>[]> {
        // Phase 1: Preserve all items (placeholder)
        return items;
    }

    async batchForget(
        items: MemoryItem<unknown>[]
    ): Promise<{
        retained: MemoryItem<unknown>[];
        forgotten: MemoryItem<unknown>[];
        merged: Array<{
            result: MemoryItem<unknown>;
            sources: MemoryItem<unknown>[];
        }>;
    }> {
        const retained: MemoryItem<unknown>[] = [];
        const forgotten: MemoryItem<unknown>[] = [];
        const merged: Array<{ result: MemoryItem<unknown>; sources: MemoryItem<unknown>[] }> = [];

        for (const item of items) {
            const result = await this.process(item);
            if (result === null) {
                forgotten.push(item);
            } else {
                retained.push(result);
            }
        }

        return { retained, forgotten, merged };
    }

    configure(config: {
        maxAgeMs?: number;
        enabled?: boolean;
        placeholder?: boolean;
        forgettingStrategy?: string;
        relevanceThreshold?: number;
        [key: string]: unknown;
    }): void {
        if (config.maxAgeMs !== undefined) {
            this.maxAgeMs = config.maxAgeMs;
        }
        if (config.enabled !== undefined) {
            this.enabled = config.enabled;
        }
        if (config.placeholder !== undefined) {
            this.placeholder = config.placeholder;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getForgettingStats() {
        return { ...this.stats };
    }
} 