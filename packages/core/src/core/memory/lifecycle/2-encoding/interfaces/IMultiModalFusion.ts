import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Multi-Modal Fusion Interface - combines multi-modal information into unified representations
 * Supports text, conversation, research, and other modality types
 */
export type IMultiModalFusion = IStageProcessor & {
    readonly stageName: 'encoding';
    readonly componentName: 'fusion';

    /**
     * Fuse multi-modal information into unified memory representation
     * @param item Memory item to process
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
        fusionWeights?: Record<string, number>;
        [key: string]: unknown;
    }): void;

    /**
     * Fuse multiple modalities into a single representation
     */
    fuseModalities(
        modalities: Array<{
            type: string;
            content: unknown;
            weight?: number;
            metadata?: Record<string, unknown>;
        }>
    ): Promise<{
        fusedContent: unknown;
        modalityWeights: Record<string, number>;
        fusionMetadata: Record<string, unknown>;
    }>;

    /**
     * Extract modalities from a memory item
     */
    extractModalities(item: MemoryItem<unknown>): Promise<Array<{
        type: string;
        content: unknown;
        confidence: number;
    }>>;

    /**
     * Get fusion statistics
     */
    getFusionStats(): {
        totalItemsProcessed: number;
        modalityDistribution: Record<string, number>;
        averageFusionComplexity: number;
        successfulFusions: number;
    };
}; 