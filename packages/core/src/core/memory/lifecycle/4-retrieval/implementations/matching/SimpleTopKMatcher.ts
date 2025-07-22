import { IMatchingStrategy } from '../../interfaces/IMatchingStrategy.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@a2arium/callagent-utils';

export class SimpleTopKMatcher implements IMatchingStrategy {
    readonly stageName = 'retrieval' as const;
    readonly componentName = 'matching' as const;
    readonly stageNumber = 4;

    private logger = logger.createLogger({ prefix: 'SimpleTopKMatcher' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private stats = {
        totalQueriesProcessed: 0,
        averageMatchesPerQuery: 0,
        averageMatchingTime: 0,
        algorithmDistribution: {} as Record<string, number>,
        averageSimilarityScore: 0,
    };

    /**
     * PHASE 1: No-op matching
     *   - Appends stageName, returns the item unchanged.
     *
     * FUTURE (Phase 2+):
     *   - Perform a vector similarity search against a VectorDB (e.g., Pinecone, 
     *     Weaviate, or FAISS) to retrieve top-K items.  
     *   - Rerank results with a small LLM call to refine based on context (e.g., "Given 
     *     this query, which of these top-10 is most relevant?").  
     *   - Libraries:
     *       • Pinecone search: https://docs.pinecone.io/docs/query-overview 
     *       • Weaviate "near vector" query: https://weaviate.io/developers/weaviate/queries/near-vector 
     *       • FAISS top k search: https://github.com/facebookresearch/faiss/wiki/Getting-started 
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;

        try {
            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            this.metrics.processingTimeMs += Date.now() - startTime;
            this.metrics.lastProcessedAt = new Date().toISOString();

            return item;
        } catch (error) {
            this.logger.error('Error in matching processing', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    async findMatches(
        query: MemoryItem<unknown> | string,
        items: MemoryItem<unknown>[]
    ): Promise<Array<MemoryItem<unknown> & { matchScore: number }>> {
        // Phase 1: Simple placeholder matching
        this.stats.totalQueriesProcessed++;

        let queryType: string;
        if (typeof query === 'string') {
            queryType = 'text';
        } else {
            queryType = query.dataType || 'unknown';
        }

        // Simple matching based on data type similarity
        const matches = items
            .filter(candidate => candidate.dataType === queryType)
            .slice(0, 5)
            .map(item => ({
                ...item,
                matchScore: 0.7 // Placeholder score
            }));

        this.stats.averageMatchesPerQuery =
            (this.stats.averageMatchesPerQuery * (this.stats.totalQueriesProcessed - 1) + matches.length) /
            this.stats.totalQueriesProcessed;

        return matches;
    }

    async rerankMatches(
        query: MemoryItem<unknown>,
        matches: Array<{
            item: MemoryItem<unknown>;
            score: number;
            rank: number;
            reasoning: string;
        }>,
        context?: string
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        score: number;
        rank: number;
        reasoning: string;
        rerankScore: number;
    }>> {
        // Phase 1: No reranking, just add placeholder rerank scores
        return matches.map(match => ({
            ...match,
            rerankScore: match.score * 0.9 // Slight adjustment
        }));
    }

    async searchSimilar(
        item: MemoryItem<unknown>,
        searchSpace: MemoryItem<unknown>[],
        options?: {
            maxResults?: number;
            minSimilarity?: number;
            searchType?: string;
        }
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        similarity: number;
        distance: number;
        metadata: Record<string, unknown>;
    }>> {
        // Phase 1: Simple similarity based on data type
        const maxResults = options?.maxResults || 10;
        const minSimilarity = options?.minSimilarity || 0.3;

        return searchSpace
            .filter(candidate => candidate.dataType === item.dataType)
            .slice(0, maxResults)
            .map(candidate => ({
                item: candidate,
                similarity: 0.6, // Placeholder
                distance: 0.4, // Placeholder
                metadata: { searchType: 'dataType' }
            }));
    }

    async calculateSimilarity(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>,
        similarityType?: string
    ): Promise<{
        score: number;
        components: Record<string, number>;
        reasoning: string;
    }> {
        // Phase 1: Simple similarity based on data type
        const score = item1.dataType === item2.dataType ? 0.7 : 0.3;

        return {
            score,
            components: { dataType: score },
            reasoning: item1.dataType === item2.dataType ? 'Same data type' : 'Different data type'
        };
    }

    async rankByRelevance(
        query: string,
        items: MemoryItem<unknown>[],
        context?: MemoryItem<unknown>[]
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        relevanceScore: number;
        rankingFactors: Record<string, number>;
        explanation: string;
    }>> {
        // Phase 1: Simple ranking by timestamp (newer = more relevant)
        return items
            .sort((a, b) => new Date(b.metadata.timestamp).getTime() - new Date(a.metadata.timestamp).getTime())
            .map((item, index) => ({
                item,
                relevanceScore: 1.0 - (index * 0.1), // Decreasing relevance
                rankingFactors: { recency: 1.0 - (index * 0.1) },
                explanation: 'Ranked by recency'
            }));
    }

    async findContextualMatches(
        targetItem: MemoryItem<unknown>,
        candidateItems: MemoryItem<unknown>[],
        contextWindow?: number
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        contextualScore: number;
        sharedContext: string[];
    }>> {
        // Phase 1: Simple contextual matching
        return candidateItems
            .filter(item => item.dataType === targetItem.dataType)
            .map(item => ({
                item,
                contextualScore: 0.6,
                sharedContext: ['dataType']
            }));
    }

    async conversationAwareMatch(
        query: string,
        items: MemoryItem<unknown>[],
        conversationContext?: MemoryItem<unknown>[]
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        conversationScore: number;
        speakerRelevance: number;
        temporalRelevance: number;
    }>> {
        // Phase 1: Simple conversation matching
        return items.map(item => ({
            item,
            conversationScore: 0.5,
            speakerRelevance: 0.5,
            temporalRelevance: 0.5
        }));
    }

    configure(config: {
        k?: number;
        threshold?: number;
        rerankingEnabled?: boolean;
        searchStrategy?: string;
        vectorProvider?: string;
        [key: string]: unknown;
    }): void {
        // Phase 1: Configuration is stored but not used
        this.logger.debug('Matcher configured', { config });
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getMatchingStats() {
        return { ...this.stats };
    }
} 