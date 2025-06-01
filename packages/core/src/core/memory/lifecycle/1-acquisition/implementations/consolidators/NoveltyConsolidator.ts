import { IExperienceConsolidator } from '../../interfaces/IExperienceConsolidator.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@callagent/utils';

export class NoveltyConsolidator implements IExperienceConsolidator {
    readonly stageName = 'acquisition' as const;
    readonly componentName = 'consolidator' as const;
    readonly stageNumber = 1;

    private logger = logger.createLogger({ prefix: 'NoveltyConsolidator' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private consolidationStats = {
        totalItemsProcessed: 0,
        itemsMerged: 0,
        duplicatesRemoved: 0,
        averageMergeRatio: 0,
    };

    private enabled: boolean;
    private strategy: string;
    private mergeAdjacentTurns: boolean;
    private preserveContext: boolean;
    private noveltyThreshold: number;
    private duplicateDetection: boolean;
    private placeholder: boolean;
    private maxMergeDistance: number;

    // Cache for recent items to check for consolidation
    private recentItems: MemoryItem<unknown>[] = [];
    private maxCacheSize = 100;

    constructor(config?: {
        enabled?: boolean;
        strategy?: string;
        mergeAdjacentTurns?: boolean;
        preserveContext?: boolean;
        noveltyThreshold?: number;
        duplicateDetection?: boolean;
        placeholder?: boolean;
        maxMergeDistance?: number;
    }) {
        this.enabled = config?.enabled ?? true;
        this.strategy = config?.strategy || 'similarity';
        this.mergeAdjacentTurns = config?.mergeAdjacentTurns ?? true;
        this.preserveContext = config?.preserveContext ?? true;
        this.noveltyThreshold = config?.noveltyThreshold || 0.8;
        this.duplicateDetection = config?.duplicateDetection ?? true;
        this.placeholder = config?.placeholder ?? true;
        this.maxMergeDistance = config?.maxMergeDistance || 5;
    }

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
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | MemoryItem<unknown>[]> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.consolidationStats.totalItemsProcessed++;

        try {
            if (!this.enabled) {
                return item;
            }

            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            // Check for consolidation opportunities
            const consolidationCandidates = await this.findConsolidationCandidates(item);

            if (consolidationCandidates.length > 0) {
                this.logger.debug('Found consolidation candidates', {
                    itemId: item.id,
                    candidateCount: consolidationCandidates.length
                });

                // Merge with candidates
                const mergedItem = await this.mergeItems([item, ...consolidationCandidates]);

                // Remove merged items from cache
                this.recentItems = this.recentItems.filter(
                    cached => !consolidationCandidates.some(candidate => candidate.id === cached.id)
                );

                this.consolidationStats.itemsMerged += consolidationCandidates.length;
                this.updateAverageMergeRatio(consolidationCandidates.length + 1, 1);

                // Add merged item to cache
                this.addToCache(mergedItem);

                this.metrics.processingTimeMs += Date.now() - startTime;
                this.metrics.lastProcessedAt = new Date().toISOString();

                return mergedItem;
            } else {
                // No consolidation needed, add to cache for future consolidation
                this.addToCache(item);

                this.metrics.processingTimeMs += Date.now() - startTime;
                this.metrics.lastProcessedAt = new Date().toISOString();

                return item;
            }
        } catch (error) {
            this.logger.error('Error in consolidation process', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    private async findConsolidationCandidates(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>[]> {
        const candidates: MemoryItem<unknown>[] = [];

        for (const cachedItem of this.recentItems) {
            const consolidationResult = await this.shouldConsolidate(item, cachedItem);

            if (consolidationResult.shouldMerge) {
                candidates.push(cachedItem);

                this.logger.debug('Found consolidation candidate', {
                    itemId: item.id,
                    candidateId: cachedItem.id,
                    similarity: consolidationResult.similarity,
                    reason: consolidationResult.reason
                });
            }
        }

        return candidates;
    }

    async shouldConsolidate(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>
    ): Promise<{
        shouldMerge: boolean;
        similarity: number;
        reason: string;
    }> {
        // Check tenant isolation
        if (item1.metadata.tenantId !== item2.metadata.tenantId) {
            return {
                shouldMerge: false,
                similarity: 0,
                reason: 'Different tenants'
            };
        }

        // Check if items are duplicates
        if (this.duplicateDetection) {
            const isDuplicate = this.checkDuplicate(item1, item2);
            if (isDuplicate) {
                this.consolidationStats.duplicatesRemoved++;
                return {
                    shouldMerge: true,
                    similarity: 1.0,
                    reason: 'Duplicate content detected'
                };
            }
        }

        // Check temporal proximity for conversation merging
        if (this.mergeAdjacentTurns && this.areAdjacentTurns(item1, item2)) {
            return {
                shouldMerge: true,
                similarity: 0.9,
                reason: 'Adjacent conversation turns'
            };
        }

        // Calculate content similarity
        const similarity = this.calculateSimilarity(item1, item2);

        if (similarity >= this.noveltyThreshold) {
            return {
                shouldMerge: true,
                similarity,
                reason: `High similarity (${similarity.toFixed(2)})`
            };
        }

        return {
            shouldMerge: false,
            similarity,
            reason: `Low similarity (${similarity.toFixed(2)})`
        };
    }

    private checkDuplicate(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>): boolean {
        // Simple duplicate detection based on content
        const content1 = JSON.stringify(item1.data);
        const content2 = JSON.stringify(item2.data);

        return content1 === content2;
    }

    private areAdjacentTurns(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>): boolean {
        if (!this.mergeAdjacentTurns) return false;

        // Check if items are from the same conversation context
        const sameAgent = item1.metadata.agentId === item2.metadata.agentId;
        const sameTask = item1.metadata.taskId === item2.metadata.taskId;

        if (!sameAgent || !sameTask) return false;

        // Check temporal proximity (within maxMergeDistance minutes)
        const time1 = new Date(item1.metadata.timestamp).getTime();
        const time2 = new Date(item2.metadata.timestamp).getTime();
        const timeDiff = Math.abs(time1 - time2) / (1000 * 60); // minutes

        return timeDiff <= this.maxMergeDistance;
    }

    private calculateSimilarity(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>): number {
        // Phase 1: Simple text-based similarity
        const text1 = this.extractText(item1.data);
        const text2 = this.extractText(item2.data);

        if (!text1 || !text2) return 0;

        // Simple Jaccard similarity on words
        const words1 = new Set(text1.toLowerCase().split(/\s+/));
        const words2 = new Set(text2.toLowerCase().split(/\s+/));

        const intersection = new Set([...words1].filter(word => words2.has(word)));
        const union = new Set([...words1, ...words2]);

        return intersection.size / union.size;
    }

    private extractText(data: unknown): string {
        if (typeof data === 'string') {
            return data;
        } else if (typeof data === 'object' && data !== null) {
            // Extract text from common object properties
            const obj = data as Record<string, unknown>;
            const textFields = ['text', 'content', 'message', 'description', 'body'];

            for (const field of textFields) {
                if (obj[field] && typeof obj[field] === 'string') {
                    return obj[field] as string;
                }
            }

            // Fallback to JSON string
            return JSON.stringify(data);
        }

        return String(data);
    }

    async mergeItems(items: MemoryItem<unknown>[]): Promise<MemoryItem<unknown>> {
        if (items.length === 0) {
            throw new Error('Cannot merge empty items array');
        }

        if (items.length === 1) {
            return items[0];
        }

        // Sort items by timestamp
        const sortedItems = items.sort((a, b) =>
            new Date(a.metadata.timestamp).getTime() - new Date(b.metadata.timestamp).getTime()
        );

        const firstItem = sortedItems[0];
        const mergedData = this.mergeData(sortedItems.map(item => item.data));

        // Combine processing histories
        const allProcessingHistory = sortedItems.flatMap(item =>
            item.metadata.processingHistory || []
        );

        // Create merged item
        const mergedItem: MemoryItem<unknown> = {
            id: firstItem.id, // Keep first item's ID
            data: mergedData,
            dataType: firstItem.dataType,
            intent: firstItem.intent,
            metadata: {
                ...firstItem.metadata,
                processingHistory: [...new Set(allProcessingHistory)], // Remove duplicates
                mergedFrom: sortedItems.slice(1).map(item => item.id),
                mergedAt: new Date().toISOString(),
                mergedCount: items.length,
            },
            processingDirectives: firstItem.processingDirectives,
        };

        this.logger.debug('Items merged', {
            resultId: mergedItem.id,
            sourceIds: items.map(item => item.id),
            mergedCount: items.length
        });

        return mergedItem;
    }

    private mergeData(dataItems: unknown[]): unknown {
        if (dataItems.length === 0) return null;
        if (dataItems.length === 1) return dataItems[0];

        // If all items are strings, concatenate them
        if (dataItems.every(item => typeof item === 'string')) {
            return dataItems.join('\n\n');
        }

        // If all items are arrays, concatenate them
        if (dataItems.every(item => Array.isArray(item))) {
            return dataItems.flat();
        }

        // If all items are objects, merge them
        if (dataItems.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
            return Object.assign({}, ...dataItems as Record<string, unknown>[]);
        }

        // Fallback: return as array
        return dataItems;
    }

    private addToCache(item: MemoryItem<unknown>): void {
        this.recentItems.push(item);

        // Maintain cache size
        if (this.recentItems.length > this.maxCacheSize) {
            this.recentItems.shift();
        }
    }

    private updateAverageMergeRatio(inputCount: number, outputCount: number): void {
        const mergeRatio = outputCount / inputCount;
        const totalMerges = this.consolidationStats.itemsMerged;

        if (totalMerges === 0) {
            this.consolidationStats.averageMergeRatio = mergeRatio;
        } else {
            this.consolidationStats.averageMergeRatio =
                (this.consolidationStats.averageMergeRatio * (totalMerges - 1) + mergeRatio) / totalMerges;
        }
    }

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
    }): void {
        if (config.enabled !== undefined) {
            this.enabled = config.enabled;
        }
        if (config.strategy !== undefined) {
            this.strategy = config.strategy;
        }
        if (config.mergeAdjacentTurns !== undefined) {
            this.mergeAdjacentTurns = config.mergeAdjacentTurns;
        }
        if (config.preserveContext !== undefined) {
            this.preserveContext = config.preserveContext;
        }
        if (config.noveltyThreshold !== undefined) {
            this.noveltyThreshold = config.noveltyThreshold;
        }
        if (config.duplicateDetection !== undefined) {
            this.duplicateDetection = config.duplicateDetection;
        }
        if (config.placeholder !== undefined) {
            this.placeholder = config.placeholder;
        }
        if (config.maxMergeDistance !== undefined) {
            this.maxMergeDistance = config.maxMergeDistance;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getConsolidationStats() {
        return { ...this.consolidationStats };
    }
} 