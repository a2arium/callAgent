import { ISelectiveForgetter } from '../../interfaces/ISelectiveForgetter.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class TimeDecayForgetter implements ISelectiveForgetter {
    readonly stageName: "derivation";
    readonly componentName: "forgetting";
    readonly stageNumber = 3;
    private logger;
    private metrics;
    private stats;
    private maxAgeMs;
    private enabled;
    private placeholder;
    constructor(config?: {
        maxAgeMs?: number;
        enabled?: boolean;
        placeholder?: boolean;
    });
    /**
     * PHASE 1: Simple time-based forgetting
     *   - Compute `age = now − timestamp`. If age > maxAge (default 24h), drop item.
     *
     * FUTURE (Phase 2+):
     *   - SimilarityDedupe: use a vector index (Pinecone or FAISS) to find near-duplicates
     *     in working memory and merge or drop.
     *   - RelevanceBasedForgetter: score each item's relevance to current goal (via LLM
     *     embedding similarity) and drop those below threshold.
     *   - Use "access frequency" heuristics: drop items not accessed in last N calls.
     *   - Libraries & examples:
     *       • Pinecone Deduplication (https://docs.pinecone.io/docs/indexing).
     *       • FAISS clustering + threshold (https://github.com/facebookresearch/faiss).
     *       • LangChain's "PruneMemory" patterns (https://js.langchain.com/docs/use_cases/memory).
     *
     * Usage for advanced forgetting:
     *   "forgetting": "SimilarityDedupe"
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
    shouldForget(item: MemoryItem<unknown>, criteria?: {
        maxAge?: number;
        relevanceThreshold?: number;
        accessFrequency?: number;
    }): Promise<{
        shouldForget: boolean;
        reason: string;
        confidence: number;
    }>;
    forgetByPattern(items: MemoryItem<unknown>[], pattern: {
        type: 'similarity' | 'frequency' | 'relevance';
        threshold: number;
        maxItems?: number;
    }): Promise<MemoryItem<unknown>[]>;
    calculateDecayScore(item: MemoryItem<unknown>, currentTime?: Date): Promise<{
        decayScore: number;
        timeDecay: number;
        importanceBoost: number;
        shouldForget: boolean;
        reasoning: string;
    }>;
    findSimilarItems(item: MemoryItem<unknown>, candidateItems: MemoryItem<unknown>[], similarityThreshold?: number): Promise<Array<{
        item: MemoryItem<unknown>;
        similarity: number;
        shouldMerge: boolean;
        shouldRemove: boolean;
    }>>;
    preserveImportant(items: MemoryItem<unknown>[], preservationCriteria?: string[]): Promise<MemoryItem<unknown>[]>;
    batchForget(items: MemoryItem<unknown>[]): Promise<{
        retained: MemoryItem<unknown>[];
        forgotten: MemoryItem<unknown>[];
        merged: Array<{
            result: MemoryItem<unknown>;
            sources: MemoryItem<unknown>[];
        }>;
    }>;
    configure(config: {
        maxAgeMs?: number;
        enabled?: boolean;
        placeholder?: boolean;
        forgettingStrategy?: string;
        relevanceThreshold?: number;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    getForgettingStats(): {
        totalItemsProcessed: number;
        itemsForgotten: number;
        itemsRetained: number;
        itemsMerged: number;
        averageDecayScore: number;
        forgettingReasons: Record<string, number>;
    };
}
