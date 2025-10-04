import { IIndexingOrchestrator } from '../../interfaces/IIndexingOrchestrator.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class DirectMemoryIndexer implements IIndexingOrchestrator {
    readonly stageName: "retrieval";
    readonly componentName: "indexing";
    readonly stageNumber = 4;
    private logger;
    private metrics;
    private stats;
    private enabled;
    private placeholder;
    constructor(config?: {
        enabled?: boolean;
        placeholder?: boolean;
    });
    /**
     * PHASE 1: No-op indexing
     *   - Appends stageName to processingHistory.
     *
     * FUTURE (Phase 2+):
     *   - VectorDBIndexer: send embeddings to Pinecone or Weaviate for persistent indexing.
     *   - KeywordIndexer: write to an Elasticsearch or OpenSearch cluster for full-text search.
     *
     * Framework Examples:
     *   • Pinecone JS client: https://www.npmjs.com/package/@pinecone-database/pinecone
     *   • Weaviate JS client: https://weaviate.io/developers/weaviate/client-libraries
     *   • Elasticsearch JS client: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/index.html
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    createIndex(items: MemoryItem<unknown>[], indexConfig?: {
        indexType?: string;
        vectorDimensions?: number;
        keywordFields?: string[];
    }): Promise<{
        indexId: string;
        itemsIndexed: number;
        indexMetadata: Record<string, unknown>;
    }>;
    updateIndex(indexId: string, items: MemoryItem<unknown>[]): Promise<{
        updated: number;
        errors: number;
    }>;
    deleteFromIndex(indexId: string, itemIds: string[]): Promise<{
        deleted: number;
        notFound: number;
    }>;
    createIndexEntries(item: MemoryItem<unknown>): Promise<Array<{
        indexType: string;
        key: string;
        value: unknown;
        weight: number;
        metadata: Record<string, unknown>;
    }>>;
    buildHierarchicalIndex(items: MemoryItem<unknown>[]): Promise<{
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
    clusterByTopic(items: MemoryItem<unknown>[], maxClusters?: number): Promise<Array<{
        topic: string;
        items: MemoryItem<unknown>[];
        centroid: unknown;
        coherence: number;
    }>>;
    updateIndexes(item: MemoryItem<unknown>, operation: 'add' | 'update' | 'remove'): Promise<{
        indexesUpdated: string[];
        operationsPerformed: number;
        updateTime: number;
    }>;
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        indexingStrategy?: string;
        vectorProvider?: string;
        keywordProvider?: string;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    getIndexingStats(): {
        totalItemsIndexed: number;
        indexTypes: Record<string, number>;
        averageIndexingTime: number;
        indexSize: number;
        cacheHitRate: number;
    };
}
