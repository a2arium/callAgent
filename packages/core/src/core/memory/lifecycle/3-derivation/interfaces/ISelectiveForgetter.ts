import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Selective Forgetter Interface - manages memory decay and removal of outdated information
 * Implements time-based decay, similarity deduplication, and importance preservation
 */
export type ISelectiveForgetter = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'forgetting';

    /**
     * Apply forgetting mechanisms to memory items
     * @param item Memory item to process
     * @returns Memory item with updated relevance/decay scores, or null if forgotten
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;

    /**
     * Configure forgetting mechanism
     */
    configure(config: {
        decayRate?: number;
        timeWindow?: string;
        retentionThreshold?: number;
        preserveImportantTurns?: boolean;
        similarityDeduplication?: boolean;
        preserveUnique?: boolean;
        placeholder?: boolean;
        forgettingStrategy?: 'time' | 'similarity' | 'importance' | 'hybrid';
        [key: string]: unknown;
    }): void;

    /**
     * Calculate decay score for a memory item
     */
    calculateDecayScore(
        item: MemoryItem<unknown>,
        currentTime?: Date
    ): Promise<{
        decayScore: number;
        timeDecay: number;
        importanceBoost: number;
        shouldForget: boolean;
        reasoning: string;
    }>;

    /**
     * Find similar items for deduplication
     */
    findSimilarItems(
        item: MemoryItem<unknown>,
        candidateItems: MemoryItem<unknown>[],
        similarityThreshold?: number
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        similarity: number;
        shouldMerge: boolean;
        shouldRemove: boolean;
    }>>;

    /**
     * Preserve important memories from forgetting
     */
    preserveImportant(
        items: MemoryItem<unknown>[],
        preservationCriteria?: string[]
    ): Promise<MemoryItem<unknown>[]>;

    /**
     * Batch process multiple items for forgetting
     */
    batchForget(
        items: MemoryItem<unknown>[]
    ): Promise<{
        retained: MemoryItem<unknown>[];
        forgotten: MemoryItem<unknown>[];
        merged: Array<{
            result: MemoryItem<unknown>;
            sources: MemoryItem<unknown>[];
        }>;
    }>;

    /**
     * Get forgetting statistics
     */
    getForgettingStats(): {
        totalItemsProcessed: number;
        itemsForgotten: number;
        itemsRetained: number;
        itemsMerged: number;
        averageDecayScore: number;
        forgettingReasons: Record<string, number>;
    };
}; 