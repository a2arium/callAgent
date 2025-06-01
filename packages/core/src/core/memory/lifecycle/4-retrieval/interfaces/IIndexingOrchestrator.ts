import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Indexing Orchestrator Interface - creates searchable indexes for memory items
 * Supports hierarchical indexing, topic clustering, and tenant isolation
 */
export type IIndexingOrchestrator = IStageProcessor & {
    readonly stageName: 'retrieval';
    readonly componentName: 'indexing';

    /**
     * Index memory items for efficient retrieval
     * @param item Memory item to index
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
        indexTypes?: string[];
        [key: string]: unknown;
    }): void;

    /**
     * Create index entries for a memory item
     */
    createIndexEntries(
        item: MemoryItem<unknown>
    ): Promise<Array<{
        indexType: string;
        key: string;
        value: unknown;
        weight: number;
        metadata: Record<string, unknown>;
    }>>;

    /**
     * Build hierarchical index structure
     */
    buildHierarchicalIndex(
        items: MemoryItem<unknown>[]
    ): Promise<{
        rootNodes: Array<{
            category: string;
            subcategories: Array<{
                name: string;
                items: MemoryItem<unknown>[];
                weight: number;
            }>;
        }>;
        totalItems: number;
        indexDepth: number;
    }>;

    /**
     * Cluster items by topic
     */
    clusterByTopic(
        items: MemoryItem<unknown>[],
        maxClusters?: number
    ): Promise<Array<{
        topic: string;
        items: MemoryItem<unknown>[];
        centroid: unknown;
        coherence: number;
    }>>;

    /**
     * Update existing indexes
     */
    updateIndexes(
        item: MemoryItem<unknown>,
        operation: 'add' | 'update' | 'remove'
    ): Promise<{
        indexesUpdated: string[];
        operationsPerformed: number;
        updateTime: number;
    }>;

    /**
     * Get indexing statistics
     */
    getIndexingStats(): {
        totalItemsIndexed: number;
        indexTypes: Record<string, number>;
        averageIndexingTime: number;
        indexSize: number;
        cacheHitRate: number;
    };
}; 