import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Selective Attention Interface - determines which parts of memory items to focus on
 * Implements attention mechanisms with conversation and speaker awareness
 */
export type ISelectiveAttention = IStageProcessor & {
    readonly stageName: 'encoding';
    readonly componentName: 'attention';
    /**
     * Apply attention mechanisms to highlight important parts of memory items
     * @param item Memory item to process
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
        attentionWindowSize?: number;
        [key: string]: unknown;
    }): void;
    /**
     * Compute attention scores for content segments
     */
    computeAttentionScores(content: string, context?: MemoryItem<unknown>[]): Promise<Array<{
        segment: string;
        score: number;
        reasoning: string;
    }>>;
    /**
     * Focus attention on specific aspects of content
     */
    focusAttention(item: MemoryItem<unknown>, focusAreas: string[]): Promise<MemoryItem<unknown>>;
    /**
     * Get attention statistics
     */
    getAttentionStats(): {
        totalItemsProcessed: number;
        averageAttentionScore: number;
        topFocusAreas: Array<{
            area: string;
            frequency: number;
            averageScore: number;
        }>;
    };
};
