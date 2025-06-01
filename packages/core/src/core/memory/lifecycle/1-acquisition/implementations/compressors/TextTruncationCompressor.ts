import { IInformationCompressor } from '../../interfaces/IInformationCompressor.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';

/**
 * Simple text truncation compressor
 * Truncates text content to a maximum length while preserving structure
 */
export class TextTruncationCompressor implements IInformationCompressor {
    readonly stageName = 'acquisition' as const;
    readonly componentName = 'compressor' as const;
    readonly stageNumber = 1;

    private maxLength: number;
    private preserveStructure: boolean;
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    constructor(config?: { maxLength?: number; preserveStructure?: boolean }) {
        this.maxLength = config?.maxLength || 1000;
        this.preserveStructure = config?.preserveStructure ?? true;
    }

    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;

        try {
            if (!item.data || typeof item.data !== 'string') {
                return item;
            }

            const content = item.data;
            if (content.length <= this.maxLength) {
                return item;
            }

            let truncatedContent: string;

            if (this.preserveStructure) {
                // Try to truncate at word boundaries
                const words = content.split(' ');
                let result = '';

                for (const word of words) {
                    if ((result + ' ' + word).length > this.maxLength) {
                        break;
                    }
                    result += (result ? ' ' : '') + word;
                }

                truncatedContent = result + (result.length < content.length ? '...' : '');
            } else {
                // Simple truncation
                truncatedContent = content.substring(0, this.maxLength - 3) + '...';
            }

            const processingTime = Date.now() - startTime;
            this.metrics.processingTimeMs += processingTime;
            this.metrics.lastProcessedAt = new Date().toISOString();

            return {
                ...item,
                data: truncatedContent,
                metadata: {
                    ...item.metadata,
                    compressed: true,
                    originalLength: content.length,
                    compressedLength: truncatedContent.length,
                    compressionRatio: truncatedContent.length / content.length,
                    processingHistory: [
                        ...(item.metadata.processingHistory || []),
                        `${this.stageName}:${this.componentName}`
                    ]
                }
            };
        } catch (error) {
            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    getName(): string {
        return 'TextTruncationCompressor';
    }

    getVersion(): string {
        return '1.0.0';
    }

    getDescription(): string {
        return 'Simple text truncation compressor that preserves word boundaries';
    }

    getConfiguration(): Record<string, unknown> {
        return {
            maxLength: this.maxLength,
            preserveStructure: this.preserveStructure
        };
    }

    configure(config: { maxLength?: number; preserveStructure?: boolean;[key: string]: unknown }): void {
        if (config.maxLength !== undefined) {
            this.maxLength = config.maxLength;
        }
        if (config.preserveStructure !== undefined) {
            this.preserveStructure = config.preserveStructure;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    async estimateCompression(item: MemoryItem<unknown>): Promise<{
        originalSize: number;
        estimatedCompressedSize: number;
        compressionRatio: number;
    }> {
        const originalSize = typeof item.data === 'string' ? item.data.length : JSON.stringify(item.data).length;
        const estimatedCompressedSize = Math.min(originalSize, this.maxLength);
        return {
            originalSize,
            estimatedCompressedSize,
            compressionRatio: estimatedCompressedSize / originalSize
        };
    }

    getCompressionStats() {
        return {
            totalItemsCompressed: this.metrics.itemsProcessed,
            averageCompressionRatio: 0.8, // Estimated
            totalBytesReduced: 0,
            averageProcessingTimeMs: this.metrics.itemsProcessed > 0 ? this.metrics.processingTimeMs / this.metrics.itemsProcessed : 0
        };
    }
} 