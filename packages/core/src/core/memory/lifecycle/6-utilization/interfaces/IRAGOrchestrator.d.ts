import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * RAG Orchestrator Interface - manages retrieval-augmented generation
 * Supports hierarchical retrieval, context generation, and relevance ranking
 */
export type IRAGOrchestrator = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'rag';
    /**
     * Prepare memory items for RAG usage
     * @param item Memory item to process
     * @returns Memory item optimized for RAG
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure RAG mechanism
     */
    configure(config: {
        strategy?: string;
        maxRetrievedItems?: number;
        contextWindow?: number;
        preserveDialogueFlow?: boolean;
        hierarchicalRetrieval?: boolean;
        reranking?: boolean;
        [key: string]: unknown;
    }): void;
    /**
     * Generate context for RAG from memory items
     */
    generateContext(query: string, retrievedItems: MemoryItem<unknown>[], options?: {
        maxLength?: number;
        includeMetadata?: boolean;
        preserveStructure?: boolean;
    }): Promise<{
        context: string;
        itemsUsed: MemoryItem<unknown>[];
        contextMetadata: Record<string, unknown>;
        truncated: boolean;
    }>;
    /**
     * Rank retrieved items for relevance
     */
    rankItems(query: string, items: MemoryItem<unknown>[], rerankingModel?: string): Promise<Array<MemoryItem<unknown> & {
        relevanceScore: number;
        rankingFactors: Record<string, number>;
        explanation: string;
    }>>;
    /**
     * Perform hierarchical retrieval
     */
    hierarchicalRetrieval(query: string, items: MemoryItem<unknown>[], levels: number): Promise<{
        levelResults: Array<{
            level: number;
            items: MemoryItem<unknown>[];
            strategy: string;
            confidence: number;
        }>;
        finalSelection: MemoryItem<unknown>[];
        hierarchyMetadata: Record<string, unknown>;
    }>;
    /**
     * Optimize context for specific use cases
     */
    optimizeContext(context: string, useCase: 'conversation' | 'research' | 'qa' | 'summarization', constraints?: {
        maxTokens?: number;
        preserveReferences?: boolean;
        includeExamples?: boolean;
    }): Promise<{
        optimizedContext: string;
        optimizations: string[];
        tokenCount: number;
        qualityScore: number;
    }>;
    /**
     * Evaluate RAG effectiveness
     */
    evaluateRAGQuality(query: string, retrievedItems: MemoryItem<unknown>[], generatedResponse: string): Promise<{
        relevanceScore: number;
        completenessScore: number;
        factualAccuracy: number;
        coherenceScore: number;
        recommendations: string[];
    }>;
    /**
     * Get RAG statistics
     */
    getRAGStats(): {
        totalQueriesProcessed: number;
        averageItemsRetrieved: number;
        averageContextLength: number;
        retrievalStrategies: Record<string, number>;
        averageRelevanceScore: number;
        contextOptimizations: Record<string, number>;
    };
};
