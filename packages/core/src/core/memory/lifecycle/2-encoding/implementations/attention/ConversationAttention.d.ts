import { ISelectiveAttention } from '../../interfaces/ISelectiveAttention.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class ConversationAttention implements ISelectiveAttention {
    readonly stageName: "encoding";
    readonly componentName: "attention";
    readonly stageNumber = 2;
    private logger;
    private metrics;
    private attentionStats;
    private passThrough;
    private preserveOrder;
    private conversationAware;
    private speakerTracking;
    private turnBoundaries;
    private llmProvider;
    private scoringCriteria;
    private attentionWindowSize;
    private focusAreaStats;
    constructor(config?: {
        passThrough?: boolean;
        preserveOrder?: boolean;
        conversationAware?: boolean;
        speakerTracking?: boolean;
        turnBoundaries?: boolean;
        llmProvider?: string;
        scoringCriteria?: string[];
        attentionWindowSize?: number;
    });
    /**
     * PHASE 1: Rule-based attention scoring
     * FUTURE: LLM-based attention mechanisms
     *
     * @see https://arxiv.org/abs/1706.03762 - Attention Is All You Need
     * @see https://platform.openai.com/docs/guides/prompt-engineering - Prompt engineering for attention
     *
     * ENHANCEMENT: Multi-Head Attention
     * Consider implementing multi-head attention patterns:
     * - Content attention: focus on semantic content
     * - Speaker attention: focus on speaker changes
     * - Temporal attention: focus on time-sensitive information
     * - Emotional attention: focus on emotional content
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    computeAttentionScores(content: string, context?: MemoryItem<unknown>[]): Promise<Array<{
        segment: string;
        score: number;
        reasoning: string;
    }>>;
    private segmentContent;
    private segmentConversation;
    private calculateSegmentScore;
    private scoreRelevance;
    private scoreNovelty;
    private scoreImportance;
    private scoreConversationalImportance;
    private generateReasoning;
    private extractText;
    private updateAttentionStats;
    private extractFocusAreas;
    focusAttention(item: MemoryItem<unknown>, focusAreas: string[]): Promise<MemoryItem<unknown>>;
    private segmentMatchesFocusArea;
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
    getMetrics(): ProcessorMetrics;
    getAttentionStats(): {
        totalItemsProcessed: number;
        averageAttentionScore: number;
        topFocusAreas: Array<{
            area: string;
            frequency: number;
            averageScore: number;
        }>;
    };
}
