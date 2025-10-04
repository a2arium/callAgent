import { IExperienceConsolidator } from '../../interfaces/IExperienceConsolidator.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class NoveltyConsolidator implements IExperienceConsolidator {
    readonly stageName: "acquisition";
    readonly componentName: "consolidator";
    readonly stageNumber = 1;
    private logger;
    private metrics;
    private consolidationStats;
    private enabled;
    private strategy;
    private mergeAdjacentTurns;
    private preserveContext;
    private noveltyThreshold;
    private duplicateDetection;
    private placeholder;
    private maxMergeDistance;
    private recentItems;
    private maxCacheSize;
    constructor(config?: {
        enabled?: boolean;
        strategy?: string;
        mergeAdjacentTurns?: boolean;
        preserveContext?: boolean;
        noveltyThreshold?: number;
        duplicateDetection?: boolean;
        placeholder?: boolean;
        maxMergeDistance?: number;
    });
    /**
     * PHASE 1: Basic similarity detection and merging
     * FUTURE: Advanced semantic similarity using embeddings
     *
     * @see https://platform.openai.com/docs/guides/embeddings - OpenAI embeddings
     * @see https://docs.pinecone.io/docs/semantic-search - Semantic search patterns
     *
     * ENHANCEMENT: Temporal Consolidation
     * Consider implementing time-based consolidation windows:
     * - Merge items within 5-minute windows for conversations
     * - Daily/weekly consolidation for research notes
     * - Adaptive windows based on content velocity
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | MemoryItem<unknown>[]>;
    private findConsolidationCandidates;
    shouldConsolidate(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>): Promise<{
        shouldMerge: boolean;
        similarity: number;
        reason: string;
    }>;
    private checkDuplicate;
    private areAdjacentTurns;
    private calculateSimilarity;
    private extractText;
    mergeItems(items: MemoryItem<unknown>[]): Promise<MemoryItem<unknown>>;
    private mergeData;
    private addToCache;
    private updateAverageMergeRatio;
    configure(config: {
        enabled?: boolean;
        strategy?: string;
        mergeAdjacentTurns?: boolean;
        preserveContext?: boolean;
        noveltyThreshold?: number;
        duplicateDetection?: boolean;
        placeholder?: boolean;
        maxMergeDistance?: number;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    getConsolidationStats(): {
        totalItemsProcessed: number;
        itemsMerged: number;
        duplicatesRemoved: number;
        averageMergeRatio: number;
    };
}
