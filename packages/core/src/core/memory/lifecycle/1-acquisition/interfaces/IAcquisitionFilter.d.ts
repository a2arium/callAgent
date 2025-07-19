import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Acquisition Filter Interface - determines which memory items should be processed
 * Implements tenant-aware filtering with relevance scoring
 */
export type IAcquisitionFilter = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'filter';
    /**
     * Filter memory items based on relevance, tenant isolation, and other criteria
     * @param item Memory item to filter
     * @returns The item if it passes filtering, null if filtered out
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
    /**
     * Configure filter with tenant-aware and context-specific settings
     */
    configure(config: {
        maxInputSize?: number;
        tenantIsolation?: boolean;
        relevanceThreshold?: number;
        conversationAware?: boolean;
        researchMode?: boolean;
        complexityAware?: boolean;
        [key: string]: unknown;
    }): void;
    /**
     * Check if an item meets the filtering criteria without processing
     */
    shouldProcess(item: MemoryItem<unknown>): Promise<boolean>;
    /**
     * Get current filter statistics
     */
    getFilterStats(): {
        totalItemsEvaluated: number;
        itemsAccepted: number;
        itemsRejected: number;
        averageRelevanceScore: number;
    };
};
