import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';
/**
 * Filter processor - determines which memory items should be processed
 */
export type IFilter = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'filter';
    /**
     * Filter memory items based on relevance, tenant isolation, etc.
     * @returns The item if it passes filtering, null if filtered out
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
    /**
     * Configure filter with tenant-aware settings
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
};
/**
 * Compressor processor - reduces memory item size while preserving important information
 */
export type ICompressor = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'compressor';
    /**
     * Compress memory item content to reduce size
     * @returns Compressed memory item
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure compressor with compression settings
     */
    configure(config: {
        maxLength?: number;
        preserveStructure?: boolean;
        preserveReferences?: boolean;
        conversationFormat?: boolean;
        llmProvider?: string;
        summaryStyle?: string;
        [key: string]: unknown;
    }): void;
};
/**
 * Consolidator processor - merges related memory items to reduce redundancy
 */
export type IConsolidator = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'consolidator';
    /**
     * Consolidate multiple related memory items
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
        [key: string]: unknown;
    }): void;
};
/**
 * Complete acquisition stage processor that orchestrates filter, compressor, and consolidator
 */
export type IAcquisitionStage = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly stageNumber: 1;
    filter: IFilter;
    compressor: ICompressor;
    consolidator: IConsolidator;
    /**
     * Process memory item through the complete acquisition pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | MemoryItem<unknown>[] | null>;
};
