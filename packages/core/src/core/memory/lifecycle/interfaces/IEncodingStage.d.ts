import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';
/**
 * Attention processor - determines which parts of memory items to focus on
 */
export type IAttention = IStageProcessor & {
    readonly stageName: 'encoding';
    readonly componentName: 'attention';
    /**
     * Apply attention mechanisms to highlight important parts of memory items
     * @returns Memory item with attention weights/scores applied
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure attention mechanism
     */
    configure(config: {
        passThrough?: boolean;
        preserveOrder?: boolean;
        conversationAware?: boolean;
        speakerTracking?: boolean;
        turnBoundaries?: boolean;
        llmProvider?: string;
        scoringCriteria?: string[];
        [key: string]: unknown;
    }): void;
};
/**
 * Fusion processor - combines multi-modal information into unified representations
 */
export type IFusion = IStageProcessor & {
    readonly stageName: 'encoding';
    readonly componentName: 'fusion';
    /**
     * Fuse multi-modal information into unified memory representation
     * @returns Memory item with fused multi-modal representation
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure fusion mechanism
     */
    configure(config: {
        modalityType?: string;
        concatenationStrategy?: string;
        speakerEmbedding?: boolean;
        temporalOrdering?: boolean;
        preserveReferences?: boolean;
        structureAware?: boolean;
        [key: string]: unknown;
    }): void;
};
/**
 * Complete encoding stage processor that orchestrates attention and fusion
 */
export type IEncodingStage = IStageProcessor & {
    readonly stageName: 'encoding';
    readonly stageNumber: 2;
    attention: IAttention;
    fusion: IFusion;
    /**
     * Process memory item through the complete encoding pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
};
