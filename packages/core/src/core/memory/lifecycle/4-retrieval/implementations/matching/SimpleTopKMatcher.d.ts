import { IMatchingStrategy } from '../../interfaces/IMatchingStrategy.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleTopKMatcher implements IMatchingStrategy {
    readonly stageName: "retrieval";
    readonly componentName: "matching";
    readonly stageNumber = 4;
    private logger;
    private metrics;
    private stats;
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
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    findMatches(query: MemoryItem<unknown> | string, items: MemoryItem<unknown>[]): Promise<Array<MemoryItem<unknown> & {
        matchScore: number;
    }>>;
    rerankMatches(query: MemoryItem<unknown>, matches: Array<{
        item: MemoryItem<unknown>;
        score: number;
        rank: number;
        reasoning: string;
    }>, context?: string): Promise<Array<{
        item: MemoryItem<unknown>;
        score: number;
        rank: number;
        reasoning: string;
        rerankScore: number;
    }>>;
    searchSimilar(item: MemoryItem<unknown>, searchSpace: MemoryItem<unknown>[], options?: {
        maxResults?: number;
        minSimilarity?: number;
        searchType?: string;
    }): Promise<Array<{
        item: MemoryItem<unknown>;
        similarity: number;
        distance: number;
        metadata: Record<string, unknown>;
    }>>;
    calculateSimilarity(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>, similarityType?: string): Promise<{
        score: number;
        components: Record<string, number>;
        reasoning: string;
    }>;
    rankByRelevance(query: string, items: MemoryItem<unknown>[], context?: MemoryItem<unknown>[]): Promise<Array<{
        item: MemoryItem<unknown>;
        relevanceScore: number;
        rankingFactors: Record<string, number>;
        explanation: string;
    }>>;
    findContextualMatches(targetItem: MemoryItem<unknown>, candidateItems: MemoryItem<unknown>[], contextWindow?: number): Promise<Array<{
        item: MemoryItem<unknown>;
        contextualScore: number;
        sharedContext: string[];
    }>>;
    conversationAwareMatch(query: string, items: MemoryItem<unknown>[], conversationContext?: MemoryItem<unknown>[]): Promise<Array<{
        item: MemoryItem<unknown>;
        conversationScore: number;
        speakerRelevance: number;
        temporalRelevance: number;
    }>>;
    configure(config: {
        k?: number;
        threshold?: number;
        rerankingEnabled?: boolean;
        searchStrategy?: string;
        vectorProvider?: string;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    getMatchingStats(): {
        totalQueriesProcessed: number;
        averageMatchesPerQuery: number;
        averageMatchingTime: number;
        algorithmDistribution: Record<string, number>;
        averageSimilarityScore: number;
    };
}
