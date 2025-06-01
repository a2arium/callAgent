import { ISummarizationEngine } from '../../interfaces/ISummarizationEngine.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@callagent/utils';

export class SimpleSummarizer implements ISummarizationEngine {
    readonly stageName = 'derivation' as const;
    readonly componentName = 'summarization' as const;
    readonly stageNumber = 3;

    private logger = logger.createLogger({ prefix: 'SimpleSummarizer' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private stats = {
        totalItemsSummarized: 0,
        averageCompressionRatio: 0,
        averageSummaryLength: 0,
        summaryStyleDistribution: {} as Record<string, number>,
    };

    private maxTopics: number;
    private summaryLength: number;
    private topicDetectionMethod: string;

    constructor(config?: {
        maxTopics?: number;
        summaryLength?: number;
        topicDetectionMethod?: string;
    }) {
        this.maxTopics = config?.maxTopics || 3;
        this.summaryLength = config?.summaryLength || 200;
        this.topicDetectionMethod = config?.topicDetectionMethod || 'keyword';
    }

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
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.stats.totalItemsSummarized++;

        try {
            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            let summarized = false;
            const originalLength = JSON.stringify(item.data).length;

            if (Array.isArray(item.data)) {
                const items = item.data as string[];
                if (items.length > 10) {
                    // PHASE 1: naive last-5 join
                    item.data = items.slice(-5).join(' ... ');
                    summarized = true;
                }
            } else if (typeof item.data === 'string' && item.data.length > this.summaryLength * 2) {
                // Simple truncation for long text
                item.data = item.data.substring(0, this.summaryLength) + '...';
                summarized = true;
            }

            if (summarized) {
                const newLength = JSON.stringify(item.data).length;
                const compressionRatio = newLength / originalLength;

                item.metadata.summarized = true;
                item.metadata.originalLength = originalLength;
                item.metadata.summaryLength = newLength;
                item.metadata.compressionRatio = compressionRatio;

                // Update stats
                this.stats.averageCompressionRatio =
                    (this.stats.averageCompressionRatio * (this.stats.totalItemsSummarized - 1) + compressionRatio) /
                    this.stats.totalItemsSummarized;
                this.stats.averageSummaryLength =
                    (this.stats.averageSummaryLength * (this.stats.totalItemsSummarized - 1) + newLength) /
                    this.stats.totalItemsSummarized;
            }

            this.metrics.processingTimeMs += Date.now() - startTime;
            this.metrics.lastProcessedAt = new Date().toISOString();

            this.logger.debug('Summarization completed', {
                itemId: item.id,
                summarized,
                originalLength,
                newLength: JSON.stringify(item.data).length
            });

            return item;
        } catch (error) {
            this.logger.error('Error in summarization processing', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    configure(config: {
        maxTopics?: number;
        summaryLength?: number;
        topicDetectionMethod?: string;
        [key: string]: unknown;
    }): void {
        if (config.maxTopics !== undefined) {
            this.maxTopics = config.maxTopics;
        }
        if (config.summaryLength !== undefined) {
            this.summaryLength = config.summaryLength;
        }
        if (config.topicDetectionMethod !== undefined) {
            this.topicDetectionMethod = config.topicDetectionMethod;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    async generateSummary(
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
    }> {
        // Phase 1: Simple truncation-based summary
        const maxLength = options?.maxLength || this.summaryLength;
        const summary = content.length > maxLength
            ? content.substring(0, maxLength) + '...'
            : content;

        return {
            summary,
            keyPoints: [summary], // Placeholder
            compressionRatio: summary.length / content.length,
            confidence: 0.5 // Placeholder confidence
        };
    }

    async createHierarchicalSummary(
        item: MemoryItem<unknown>,
        levels: number
    ): Promise<Array<{
        level: number;
        summary: string;
        detail: number;
        wordCount: number;
    }>> {
        // Phase 1: Simple multi-level truncation
        const content = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
        const results = [];

        for (let level = 1; level <= levels; level++) {
            const targetLength = Math.floor(this.summaryLength / level);
            const summary = content.length > targetLength
                ? content.substring(0, targetLength) + '...'
                : content;

            results.push({
                level,
                summary,
                detail: 1 - (level - 1) / levels, // Higher level = less detail
                wordCount: summary.split(/\s+/).length
            });
        }

        return results;
    }

    async summarizeCollection(
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
    }> {
        // Phase 1: Simple concatenation and grouping
        const maxLength = options?.maxSummaryLength || this.summaryLength;
        const allContent = items.map(item =>
            typeof item.data === 'string' ? item.data : JSON.stringify(item.data)
        ).join(' ');

        const overallSummary = allContent.length > maxLength
            ? allContent.substring(0, maxLength) + '...'
            : allContent;

        // Simple grouping by data type
        const groups = new Map<string, MemoryItem<unknown>[]>();
        for (const item of items) {
            const group = item.dataType || 'unknown';
            if (!groups.has(group)) {
                groups.set(group, []);
            }
            groups.get(group)!.push(item);
        }

        const groupSummaries = Array.from(groups.entries()).map(([group, groupItems]) => ({
            group,
            summary: `${groupItems.length} items of type ${group}`,
            itemCount: groupItems.length
        }));

        return {
            overallSummary,
            groupSummaries
        };
    }

    getSummarizationStats() {
        return { ...this.stats };
    }
} 