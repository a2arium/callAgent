import { IMultiModalFusion } from '../../interfaces/IMultiModalFusion.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class ModalityFusion implements IMultiModalFusion {
    readonly stageName: "encoding";
    readonly componentName: "fusion";
    readonly stageNumber = 2;
    private logger;
    private metrics;
    private fusionStats;
    private modalityType;
    private concatenationStrategy;
    private speakerEmbedding;
    private temporalOrdering;
    private preserveReferences;
    private structureAware;
    private fusionWeights;
    constructor(config?: {
        modalityType?: string;
        concatenationStrategy?: string;
        speakerEmbedding?: boolean;
        temporalOrdering?: boolean;
        preserveReferences?: boolean;
        structureAware?: boolean;
        fusionWeights?: Record<string, number>;
    });
    /**
     * PHASE 1: Simple concatenation and weighted fusion
     * FUTURE: Advanced multi-modal fusion with embeddings
     *
     * @see https://arxiv.org/abs/1908.02265 - Multi-modal fusion techniques
     * @see https://platform.openai.com/docs/guides/vision - Vision and text fusion
     *
     * ENHANCEMENT: Cross-Modal Attention
     * Consider implementing cross-modal attention mechanisms:
     * - Text-to-image attention for visual content
     * - Audio-to-text alignment for speech
     * - Temporal fusion for time-series data
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Extract modalities from memory item data
     *
     * This method is designed to be extensible - it can handle any modality type:
     * - text, audio, image, video (media modalities)
     * - metadata, structured, temporal (context modalities)
     * - sensor, geolocation, biometric (IoT modalities)
     * - custom domain-specific modalities
     *
     * To add new modality extractors, simply add detection logic below.
     */
    extractModalities(item: MemoryItem<unknown>): Promise<Array<{
        type: string;
        content: unknown;
        confidence: number;
    }>>;
    private extractTextContent;
    private extractImageContent;
    private extractAudioContent;
    private extractStructuredContent;
    private extractTimeContext;
    private getTimeOfDay;
    fuseModalities(modalities: Array<{
        type: string;
        content: unknown;
        weight?: number;
        metadata?: Record<string, unknown>;
    }>): Promise<{
        fusedContent: unknown;
        modalityWeights: Record<string, number>;
        fusionMetadata: Record<string, unknown>;
    }>;
    private weightedFusion;
    private concatenationFusion;
    private hierarchicalFusion;
    private updateFusionComplexity;
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
    getMetrics(): ProcessorMetrics;
    getFusionStats(): {
        totalItemsProcessed: number;
        modalityDistribution: Record<string, number>;
        averageFusionComplexity: number;
        successfulFusions: number;
    };
}
