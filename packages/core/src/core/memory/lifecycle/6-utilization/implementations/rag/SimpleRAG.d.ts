import { IRAGOrchestrator } from '../../interfaces/IRAGOrchestrator.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleRAG implements IRAGOrchestrator {
    readonly stageName: "utilization";
    readonly componentName: "rag";
    readonly stageNumber = 6;
    private metrics;
    /**
     * PHASE 1: No-op Retrieval-Augmented Generation
     *   - Appends stageName, returns unchanged.
     *
     * FUTURE (Phase 2+):
     *   - Implement a full RAG pipeline:
     *       1. Call a retriever (e.g., Pinecone, Weaviate) to get top-k contexts.
     *       2. Call an LLM (OpenAI GPT-4, Anthropic Claude, Llama 2) with a prompt:
     *            "Given these contexts, answer the query: …."
     *       3. Combine retrieved context with user input in prompt templates.
     *   - Use libraries:
     *       • LangChain: RAGChain (https://js.langchain.com/docs/use_cases/retrieval_augmentation/).
     *       • Haystack: RAG pipelines in Python (https://github.com/deepset-ai/haystack).
     *       • LlamaIndex: RAG examples (https://gpt-index.readthedocs.io/en/latest/use_cases/rag.html).
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    configure(config: {
        strategy?: string;
        maxRetrievedItems?: number;
        contextWindow?: number;
        preserveDialogueFlow?: boolean;
        hierarchicalRetrieval?: boolean;
        reranking?: boolean;
        [key: string]: unknown;
    }): void;
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
    rankItems(query: string, items: MemoryItem<unknown>[], rerankingModel?: string): Promise<Array<MemoryItem<unknown> & {
        relevanceScore: number;
        rankingFactors: Record<string, number>;
        explanation: string;
    }>>;
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
    evaluateRAGQuality(query: string, retrievedItems: MemoryItem<unknown>[], generatedResponse: string): Promise<{
        relevanceScore: number;
        completenessScore: number;
        factualAccuracy: number;
        coherenceScore: number;
        recommendations: string[];
    }>;
    getRAGStats(): {
        totalQueriesProcessed: number;
        averageItemsRetrieved: number;
        averageContextLength: number;
        retrievalStrategies: Record<string, number>;
        averageRelevanceScore: number;
        contextOptimizations: Record<string, number>;
    };
    getMetrics(): ProcessorMetrics;
}
