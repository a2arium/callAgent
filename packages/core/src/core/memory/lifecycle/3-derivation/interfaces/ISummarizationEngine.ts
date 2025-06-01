import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Summarization Engine Interface - creates concise summaries of memory items
 * Supports dialogue-aware, topic-aware, and hierarchical summarization
 */
export type ISummarizationEngine = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'summarization';

    /**
     * Generate summaries of memory items
     * @param item Memory item to summarize
     * @returns Memory item with summary added or replaced content
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Configure summarization mechanism
     */
    configure(config: {
        strategy?: string;
        maxSummaryLength?: number;
        preserveSpeakers?: boolean;
        topicAware?: boolean;
        hierarchicalSummary?: boolean;
        llmProvider?: string;
        placeholder?: boolean;
        summaryStyle?: 'bullet' | 'paragraph' | 'structured';
        [key: string]: unknown;
    }): void;

    /**
     * Generate summary with specific parameters
     */
    generateSummary(
        content: string,
        options?: {
            maxLength?: number;
            style?: string;
            focusAreas?: string[];
            preserveDetails?: string[];
        }
    ): Promise<{
        summary: string;
        keyPoints: string[];
        compressionRatio: number;
        confidence: number;
    }>;

    /**
     * Create hierarchical summary with multiple levels
     */
    createHierarchicalSummary(
        item: MemoryItem<unknown>,
        levels: number
    ): Promise<Array<{
        level: number;
        summary: string;
        detail: number; // 0-1 scale
        wordCount: number;
    }>>;

    /**
     * Summarize multiple related items together
     */
    summarizeCollection(
        items: MemoryItem<unknown>[],
        options?: {
            groupBy?: string;
            maxSummaryLength?: number;
            preserveTimeline?: boolean;
        }
    ): Promise<{
        overallSummary: string;
        groupSummaries: Array<{
            group: string;
            summary: string;
            itemCount: number;
        }>;
    }>;

    /**
     * Get summarization statistics
     */
    getSummarizationStats(): {
        totalItemsSummarized: number;
        averageCompressionRatio: number;
        averageSummaryLength: number;
        summaryStyleDistribution: Record<string, number>;
    };
}; 