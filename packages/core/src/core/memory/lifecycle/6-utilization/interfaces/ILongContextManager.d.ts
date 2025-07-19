import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Long Context Manager Interface - handles long context windows and memory management
 * Supports chunking, merging, and hierarchical context strategies
 */
export type ILongContextManager = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'longContext';
    /**
     * Manage long context for memory items
     * @param item Memory item to process
     * @returns Memory item with context management metadata
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure long context management
     */
    configure(config: {
        windowSize?: number;
        overlapSize?: number;
        strategy?: string;
        preserveTurnBoundaries?: boolean;
        preserveStructure?: boolean;
        chunkingMethod?: 'sliding' | 'semantic' | 'hierarchical';
        [key: string]: unknown;
    }): void;
    /**
     * Split content into manageable chunks
     */
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
    /**
     * Merge chunks back into coherent content
     */
    mergeChunks(chunks: Array<{
        chunk: string;
        index: number;
        metadata?: Record<string, unknown>;
    }>, strategy?: 'concatenate' | 'semantic' | 'weighted'): Promise<{
        mergedContent: string;
        mergeMetadata: Record<string, unknown>;
        qualityScore: number;
    }>;
    /**
     * Manage hierarchical context windows
     */
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
    /**
     * Optimize context for token limits
     */
    optimizeForTokenLimit(content: string, maxTokens: number, preservationPriorities?: string[]): Promise<{
        optimizedContent: string;
        tokenCount: number;
        reductionRatio: number;
        preservedElements: string[];
        removedElements: string[];
    }>;
    /**
     * Create sliding window over content
     */
    createSlidingWindow(content: string, windowSize: number, stepSize: number): Promise<Array<{
        window: string;
        position: number;
        overlap: number;
        contextScore: number;
    }>>;
    /**
     * Evaluate context quality
     */
    evaluateContextQuality(originalContent: string, processedContent: string, metrics?: string[]): Promise<{
        coherenceScore: number;
        completenessScore: number;
        compressionScore: number;
        qualityMetrics: Record<string, number>;
        recommendations: string[];
    }>;
    /**
     * Get context management statistics
     */
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
};
