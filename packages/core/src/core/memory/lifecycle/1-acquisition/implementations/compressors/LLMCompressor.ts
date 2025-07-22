import { IInformationCompressor } from '../../interfaces/IInformationCompressor.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@a2arium/callagent-utils';

export class LLMCompressor implements IInformationCompressor {
    readonly stageName = 'acquisition' as const;
    readonly componentName = 'compressor' as const;
    readonly stageNumber = 1;

    private logger = logger.createLogger({ prefix: 'LLMCompressor' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private compressionStats = {
        totalItemsCompressed: 0,
        averageCompressionRatio: 0,
        totalBytesReduced: 0,
        averageProcessingTimeMs: 0,
    };

    private maxLength: number;
    private preserveStructure: boolean;
    private preserveReferences: boolean;
    private conversationFormat: boolean;
    private llmProvider: string;
    private summaryStyle: string;
    private compressionRatio: number;

    constructor(config?: {
        maxLength?: number;
        preserveStructure?: boolean;
        preserveReferences?: boolean;
        conversationFormat?: boolean;
        llmProvider?: string;
        summaryStyle?: string;
        compressionRatio?: number;
    }) {
        this.maxLength = config?.maxLength || 2000;
        this.preserveStructure = config?.preserveStructure || true;
        this.preserveReferences = config?.preserveReferences || true;
        this.conversationFormat = config?.conversationFormat || false;
        this.llmProvider = config?.llmProvider || 'placeholder';
        this.summaryStyle = config?.summaryStyle || 'concise';
        this.compressionRatio = config?.compressionRatio || 0.5;
    }

    /**
     * PHASE 1: Simple text truncation and basic compression
     * FUTURE: LLM-based intelligent summarization
     * 
     * @see https://platform.openai.com/docs/guides/text-generation - OpenAI summarization
     * @see https://docs.anthropic.com/claude/docs/summarization - Claude summarization
     * 
     * ENHANCEMENT: Adaptive Compression
     * Consider implementing adaptive compression based on content type:
     * - Code: preserve syntax, compress comments
     * - Conversations: preserve speaker turns, compress filler
     * - Documents: preserve structure, compress redundancy
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.compressionStats.totalItemsCompressed++;

        try {
            const originalSize = JSON.stringify(item.data).length;

            // Perform compression
            const compressedData = await this.compressData(item.data);
            const compressedSize = JSON.stringify(compressedData).length;

            // Calculate compression ratio
            const actualCompressionRatio = compressedSize / originalSize;
            this.compressionStats.totalBytesReduced += (originalSize - compressedSize);

            // Update average compression ratio
            this.compressionStats.averageCompressionRatio =
                (this.compressionStats.averageCompressionRatio * (this.compressionStats.totalItemsCompressed - 1) +
                    actualCompressionRatio) / this.compressionStats.totalItemsCompressed;

            // Create compressed item
            const compressedItem: MemoryItem<unknown> = {
                ...item,
                data: compressedData,
                metadata: {
                    ...item.metadata,
                    compressed: true,
                    originalSize,
                    compressedSize,
                    compressionRatio: actualCompressionRatio,
                    processingHistory: [
                        ...(item.metadata.processingHistory || []),
                        `${this.stageName}:${this.componentName}`
                    ]
                }
            };

            const processingTime = Date.now() - startTime;
            this.metrics.processingTimeMs += processingTime;
            this.compressionStats.averageProcessingTimeMs =
                (this.compressionStats.averageProcessingTimeMs * (this.compressionStats.totalItemsCompressed - 1) +
                    processingTime) / this.compressionStats.totalItemsCompressed;
            this.metrics.lastProcessedAt = new Date().toISOString();

            this.logger.debug('Item compressed', {
                itemId: item.id,
                originalSize,
                compressedSize,
                ratio: actualCompressionRatio
            });

            return compressedItem;
        } catch (error) {
            this.logger.error('Error compressing item', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item; // Return original item if compression fails
        }
    }

    private async compressData(data: unknown): Promise<unknown> {
        if (typeof data === 'string') {
            return this.compressText(data);
        } else if (typeof data === 'object' && data !== null) {
            return this.compressObject(data);
        }
        return data;
    }

    private compressText(text: string): string {
        // Phase 1: Simple truncation with smart boundaries
        if (text.length <= this.maxLength) {
            return text;
        }

        if (this.conversationFormat) {
            return this.compressConversation(text);
        }

        // Find good truncation point (sentence boundary)
        const targetLength = Math.floor(this.maxLength * this.compressionRatio);
        let truncateAt = targetLength;

        // Look for sentence endings near target length
        const sentenceEndings = ['. ', '! ', '? ', '\n\n'];
        for (const ending of sentenceEndings) {
            const lastIndex = text.lastIndexOf(ending, targetLength);
            if (lastIndex > targetLength * 0.8) {
                truncateAt = lastIndex + ending.length;
                break;
            }
        }

        let compressed = text.substring(0, truncateAt);

        if (truncateAt < text.length) {
            compressed += '... [compressed]';
        }

        return compressed;
    }

    private compressConversation(text: string): string {
        // Preserve speaker turns and important dialogue
        const lines = text.split('\n');
        const compressed: string[] = [];
        let currentLength = 0;

        for (const line of lines) {
            if (currentLength + line.length > this.maxLength) {
                break;
            }

            // Preserve speaker indicators
            if (line.includes(':') || line.trim().startsWith('-')) {
                compressed.push(line);
                currentLength += line.length + 1;
            } else if (line.trim().length > 0 && currentLength < this.maxLength * 0.8) {
                compressed.push(line);
                currentLength += line.length + 1;
            }
        }

        return compressed.join('\n');
    }

    private compressObject(obj: unknown): unknown {
        // Phase 1: Simple object compression
        if (Array.isArray(obj)) {
            return obj.slice(0, Math.floor(obj.length * this.compressionRatio));
        }

        if (typeof obj === 'object' && obj !== null) {
            const compressed: Record<string, unknown> = {};
            const entries = Object.entries(obj);
            const keepCount = Math.floor(entries.length * this.compressionRatio);

            // Keep most important entries (by key priority)
            const priorityKeys = ['id', 'title', 'content', 'text', 'message', 'data'];
            const sortedEntries = entries.sort(([a], [b]) => {
                const aPriority = priorityKeys.indexOf(a);
                const bPriority = priorityKeys.indexOf(b);
                if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
                if (aPriority !== -1) return -1;
                if (bPriority !== -1) return 1;
                return 0;
            });

            for (let i = 0; i < Math.min(keepCount, sortedEntries.length); i++) {
                const [key, value] = sortedEntries[i];
                compressed[key] = value;
            }

            return compressed;
        }

        return obj;
    }

    async estimateCompression(item: MemoryItem<unknown>): Promise<{
        originalSize: number;
        estimatedCompressedSize: number;
        compressionRatio: number;
    }> {
        const originalSize = JSON.stringify(item.data).length;
        const estimatedCompressedSize = Math.floor(originalSize * this.compressionRatio);

        return {
            originalSize,
            estimatedCompressedSize,
            compressionRatio: this.compressionRatio,
        };
    }

    configure(config: {
        maxLength?: number;
        preserveStructure?: boolean;
        preserveReferences?: boolean;
        conversationFormat?: boolean;
        llmProvider?: string;
        summaryStyle?: string;
        compressionRatio?: number;
        [key: string]: unknown;
    }): void {
        if (config.maxLength !== undefined) {
            this.maxLength = config.maxLength;
        }
        if (config.preserveStructure !== undefined) {
            this.preserveStructure = config.preserveStructure;
        }
        if (config.preserveReferences !== undefined) {
            this.preserveReferences = config.preserveReferences;
        }
        if (config.conversationFormat !== undefined) {
            this.conversationFormat = config.conversationFormat;
        }
        if (config.llmProvider !== undefined) {
            this.llmProvider = config.llmProvider;
        }
        if (config.summaryStyle !== undefined) {
            this.summaryStyle = config.summaryStyle;
        }
        if (config.compressionRatio !== undefined) {
            this.compressionRatio = config.compressionRatio;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getCompressionStats() {
        return { ...this.compressionStats };
    }
} 