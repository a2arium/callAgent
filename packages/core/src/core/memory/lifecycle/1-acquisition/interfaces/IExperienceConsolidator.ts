import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Experience Consolidator Interface - merges related memory items to reduce redundancy
 * Implements novelty scoring and duplicate detection
 */
export type IExperienceConsolidator = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'consolidator';

    /**
     * Consolidate multiple related memory items
     * @param item Memory item to consolidate
     * @returns Single consolidated item or array of items
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | MemoryItem<unknown>[]>;

    /**
     * Configure consolidator with merging settings
     */
    configure(config: {
        enabled?: boolean;
        strategy?: string;
        mergeAdjacentTurns?: boolean;
        preserveContext?: boolean;
        noveltyThreshold?: number;
        duplicateDetection?: boolean;
        placeholder?: boolean;
        maxMergeDistance?: number;
        [key: string]: unknown;
    }): void;

    /**
     * Check if two items should be consolidated
     */
    shouldConsolidate(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>
    ): Promise<{
        shouldMerge: boolean;
        similarity: number;
        reason: string;
    }>;

    /**
     * Merge multiple items into a single consolidated item
     */
    mergeItems(items: MemoryItem<unknown>[]): Promise<MemoryItem<unknown>>;

    /**
     * Get consolidation statistics
     */
    getConsolidationStats(): {
        totalItemsProcessed: number;
        itemsMerged: number;
        duplicatesRemoved: number;
        averageMergeRatio: number;
    };
}; 