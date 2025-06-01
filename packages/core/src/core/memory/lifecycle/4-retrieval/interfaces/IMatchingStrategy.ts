import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Matching Strategy Interface - finds relevant memory items based on queries
 * Supports semantic, contextual, and conversation-aware matching
 */
export type IMatchingStrategy = IStageProcessor & {
    readonly stageName: 'retrieval';
    readonly componentName: 'matching';

    /**
     * Match memory items against queries or other items
     * @param item Memory item to process
     * @returns Memory item with matching scores/metadata added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Configure matching mechanism
     */
    configure(config: {
        topK?: number;
        similarityThreshold?: number;
        algorithm?: string;
        conversationAware?: boolean;
        researchMode?: boolean;
        matchingWeights?: Record<string, number>;
        [key: string]: unknown;
    }): void;

    /**
     * Find matching items for a given query
     * @param query The search query or memory item to match against
     * @param items Pool of items to search through
     * @returns Array of matching items with scores
     */
    findMatches(
        query: MemoryItem<unknown> | string,
        items: MemoryItem<unknown>[]
    ): Promise<Array<MemoryItem<unknown> & { matchScore: number }>>;

    /**
     * Calculate similarity between two items
     */
    calculateSimilarity(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>,
        similarityType?: string
    ): Promise<{
        score: number;
        components: Record<string, number>;
        reasoning: string;
    }>;

    /**
     * Rank items by relevance to a query
     */
    rankByRelevance(
        query: string,
        items: MemoryItem<unknown>[],
        context?: MemoryItem<unknown>[]
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        relevanceScore: number;
        rankingFactors: Record<string, number>;
        explanation: string;
    }>>;

    /**
     * Find contextually similar items
     */
    findContextualMatches(
        targetItem: MemoryItem<unknown>,
        candidateItems: MemoryItem<unknown>[],
        contextWindow?: number
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        contextualScore: number;
        sharedContext: string[];
    }>>;

    /**
     * Perform conversation-aware matching
     */
    conversationAwareMatch(
        query: string,
        items: MemoryItem<unknown>[],
        conversationContext?: MemoryItem<unknown>[]
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        conversationScore: number;
        speakerRelevance: number;
        temporalRelevance: number;
    }>>;

    /**
     * Get matching statistics
     */
    getMatchingStats(): {
        totalQueriesProcessed: number;
        averageMatchesPerQuery: number;
        averageMatchingTime: number;
        algorithmDistribution: Record<string, number>;
        averageSimilarityScore: number;
    };
}; 