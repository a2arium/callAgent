import { ISummarizationEngine } from '../../interfaces/ISummarizationEngine.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleSummarizer implements ISummarizationEngine {
    readonly stageName: "derivation";
    readonly componentName: "summarization";
    readonly stageNumber = 3;
    private logger;
    private metrics;
    private stats;
    private maxTopics;
    private summaryLength;
    private topicDetectionMethod;
    constructor(config?: {
        maxTopics?: number;
        summaryLength?: number;
        topicDetectionMethod?: string;
    });
    /**
     * PHASE 1: Basic concatenation summarization
     *   - If item.data is an array of strings, take the last 5 items, join with " ... ".
     *   - Marks metadata.summarized = true if summarization occurred.
     *
     * FUTURE (Phase 2+):
     *   - TopicAwareSummarizer: cluster item.data by topic using zero-shot topic detection
     *     (e.g., GPT-4 with "extract topics from these texts" prompt, or Scikit-Learn
     *     LDA (https://scikit-learn.org/stable/modules/generated/sklearn.decomposition.LatentDirichletAllocation.html)).
     *   - Summarize each topic separately with an LLM:
     *       • OpenAI: (text-davinci-003) summary calls with "Summarize under 200 words."
     *       • HuggingFace transformers "facebook/bart-large-cnn" or "t5-base."
     *   - Merge topic summaries into a global summary using a second LLM call.
     *   - Libraries & examples:
     *       • LangChain ChatSummarization (https://js.langchain.com/docs/use_cases/memory).
     *       • LlamaIndex's "TreeSummarizer" for hierarchical summarization
     *         (https://gpt-index.readthedocs.io/en/latest/modules/indices/summary.html).
     *
     * Configuration options:
     *   - maxTopics: 3
     *   - summaryLength: 200
     *   - topicDetectionMethod: "embedding" | "llm" | "keyword"
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    configure(config: {
        maxTopics?: number;
        summaryLength?: number;
        topicDetectionMethod?: string;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    generateSummary(content: string, options?: {
        maxLength?: number;
        style?: string;
        focusAreas?: string[];
        preserveDetails?: string[];
    }): Promise<{
        summary: string;
        keyPoints: string[];
        compressionRatio: number;
        confidence: number;
    }>;
    createHierarchicalSummary(item: MemoryItem<unknown>, levels: number): Promise<Array<{
        level: number;
        summary: string;
        detail: number;
        wordCount: number;
    }>>;
    summarizeCollection(items: MemoryItem<unknown>[], options?: {
        groupBy?: string;
        maxSummaryLength?: number;
        preserveTimeline?: boolean;
    }): Promise<{
        overallSummary: string;
        groupSummaries: Array<{
            group: string;
            summary: string;
            itemCount: number;
        }>;
    }>;
    getSummarizationStats(): {
        totalItemsSummarized: number;
        averageCompressionRatio: number;
        averageSummaryLength: number;
        summaryStyleDistribution: Record<string, number>;
    };
}
