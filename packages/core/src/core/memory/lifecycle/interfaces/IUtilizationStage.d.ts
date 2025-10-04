import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';
/**
 * RAG (Retrieval-Augmented Generation) processor - manages retrieval-augmented generation
 */
export type IRAG = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'rag';
    /**
     * Prepare memory items for RAG usage
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
        [key: string]: unknown;
    }): void;
    /**
     * Generate context for RAG from memory items
     */
    generateContext(query: string, retrievedItems: MemoryItem<unknown>[]): Promise<string>;
    /**
     * Rank retrieved items for relevance
     */
    rankItems(query: string, items: MemoryItem<unknown>[]): Promise<Array<MemoryItem<unknown> & {
        relevanceScore: number;
    }>>;
};
/**
 * Long context manager - handles long context windows and memory management
 */
export type ILongContext = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'longContext';
    /**
     * Manage long context for memory items
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
        [key: string]: unknown;
    }): void;
    /**
     * Split content into manageable chunks
     */
    chunkContent(content: string, windowSize: number, overlapSize: number): Promise<string[]>;
    /**
     * Merge chunks back into coherent content
     */
    mergeChunks(chunks: string[]): Promise<string>;
};
/**
 * Hallucination mitigation processor - reduces hallucinations and ensures accuracy
 */
export type IHallucinationMitigation = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'hallucinationMitigation';
    /**
     * Apply hallucination mitigation to memory items
     * @returns Memory item with mitigation metadata
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure hallucination mitigation
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        consistencyChecking?: boolean;
        conversationAware?: boolean;
        factChecking?: boolean;
        sourceVerification?: boolean;
        researchMode?: boolean;
        [key: string]: unknown;
    }): void;
    /**
     * Verify content against known facts
     */
    verifyContent(content: string, sources: MemoryItem<unknown>[]): Promise<{
        isVerified: boolean;
        confidence: number;
        issues: string[];
    }>;
    /**
     * Check consistency across memory items
     */
    checkConsistency(items: MemoryItem<unknown>[]): Promise<{
        isConsistent: boolean;
        conflicts: Array<{
            item1: MemoryItem<unknown>;
            item2: MemoryItem<unknown>;
            conflictType: string;
        }>;
    }>;
};
/**
 * Complete utilization stage processor that orchestrates RAG, long context, and hallucination mitigation
 */
export type IUtilizationStage = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly stageNumber: 6;
    rag: IRAG;
    longContext: ILongContext;
    hallucinationMitigation: IHallucinationMitigation;
    /**
     * Process memory item through the complete utilization pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Prepare memory items for final utilization
     */
    prepareForUtilization(query: string, items: MemoryItem<unknown>[]): Promise<{
        context: string;
        verifiedItems: MemoryItem<unknown>[];
        confidence: number;
    }>;
};
