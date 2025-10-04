import { ILongContextManager } from '../../interfaces/ILongContextManager.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleLongContextManager implements ILongContextManager {
    readonly stageName: "utilization";
    readonly componentName: "longContext";
    readonly stageNumber = 6;
    private logger;
    private metrics;
    private stats;
    /**
     * PHASE 1: No-op long context management
     *   - Appends stageName, returns the item unchanged.
     *
     * FUTURE (Phase 2+):
     *   - Implement sliding window chunking with semantic boundaries
     *   - Use LLM-based summarization for hierarchical context compression
     *   - Implement token-aware optimization for different model context limits
     *   - Libraries:
     *       • tiktoken for token counting: https://github.com/dqbd/tiktoken
     *       • LangChain text splitters: https://js.langchain.com/docs/modules/data_connection/document_transformers/
     *       • Semantic chunking with embeddings
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    configure(config: {
        windowSize?: number;
        overlapSize?: number;
        strategy?: string;
        preserveTurnBoundaries?: boolean;
        preserveStructure?: boolean;
        chunkingMethod?: 'sliding' | 'semantic' | 'hierarchical';
        [key: string]: unknown;
    }): void;
    chunkContent(content: string, windowSize: number, overlapSize: number, options?: {
        preserveBoundaries?: boolean;
        semanticAware?: boolean;
        metadata?: Record<string, unknown>;
    }): Promise<Array<{
        chunk: string;
        index: number;
        startPosition: number;
        endPosition: number;
        metadata: Record<string, unknown>;
    }>>;
    mergeChunks(chunks: Array<{
        chunk: string;
        index: number;
        metadata?: Record<string, unknown>;
    }>, strategy?: 'concatenate' | 'semantic' | 'weighted'): Promise<{
        mergedContent: string;
        mergeMetadata: Record<string, unknown>;
        qualityScore: number;
    }>;
    manageHierarchicalContext(items: MemoryItem<unknown>[], levels: number, windowSizes: number[]): Promise<{
        levels: Array<{
            level: number;
            windowSize: number;
            items: MemoryItem<unknown>[];
            summary: string;
        }>;
        totalContextSize: number;
        compressionRatio: number;
    }>;
    optimizeForTokenLimit(content: string, maxTokens: number, preservationPriorities?: string[]): Promise<{
        optimizedContent: string;
        tokenCount: number;
        reductionRatio: number;
        preservedElements: string[];
        removedElements: string[];
    }>;
    createSlidingWindow(content: string, windowSize: number, stepSize: number): Promise<Array<{
        window: string;
        position: number;
        overlap: number;
        contextScore: number;
    }>>;
    evaluateContextQuality(originalContent: string, processedContent: string, metrics?: string[]): Promise<{
        coherenceScore: number;
        completenessScore: number;
        compressionScore: number;
        qualityMetrics: Record<string, number>;
        recommendations: string[];
    }>;
    getContextStats(): {
        totalContentProcessed: number;
        averageChunkSize: number;
        averageOverlapRatio: number;
        chunkingStrategies: Record<string, number>;
        averageCompressionRatio: number;
        contextQualityScores: {
            coherence: number;
            completeness: number;
            compression: number;
        };
    };
    getMetrics(): ProcessorMetrics;
}
