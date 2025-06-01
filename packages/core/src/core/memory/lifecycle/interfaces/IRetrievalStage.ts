import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';

/**
 * Indexing processor - creates searchable indexes for memory items
 */
export type IIndexing = IStageProcessor & {
    readonly stageName: 'retrieval';
    readonly componentName: 'indexing';

    /**
     * Index memory items for efficient retrieval
     * @returns Memory item with indexing metadata added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Configure indexing mechanism
     */
    configure(config: {
        strategy?: string;
        cacheEnabled?: boolean;
        tenantIsolation?: boolean;
        speakerAware?: boolean;
        topicIndexing?: boolean;
        hierarchicalIndexing?: boolean;
        topicClustering?: boolean;
        [key: string]: unknown;
    }): void;
};

/**
 * Matching processor - finds relevant memory items based on queries
 */
export type IMatching = IStageProcessor & {
    readonly stageName: 'retrieval';
    readonly componentName: 'matching';

    /**
     * Match memory items against queries or other items
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
};

/**
 * Complete retrieval stage processor that orchestrates indexing and matching
 */
export type IRetrievalStage = IStageProcessor & {
    readonly stageName: 'retrieval';
    readonly stageNumber: 4;

    indexing: IIndexing;
    matching: IMatching;

    /**
     * Process memory item through the complete retrieval pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Retrieve relevant items based on a query
     */
    retrieve(
        query: MemoryItem<unknown> | string,
        items: MemoryItem<unknown>[]
    ): Promise<Array<MemoryItem<unknown> & { matchScore: number }>>;
}; 