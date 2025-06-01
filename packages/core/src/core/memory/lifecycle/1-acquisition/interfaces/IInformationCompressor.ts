import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Information Compressor Interface - reduces memory item size while preserving important information
 * Supports multiple compression strategies including LLM-based summarization
 */
export type IInformationCompressor = IStageProcessor & {
    readonly stageName: 'acquisition';
    readonly componentName: 'compressor';

    /**
     * Compress memory item content to reduce size
     * @param item Memory item to compress
     * @returns Compressed memory item
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Configure compressor with compression settings
     */
    configure(config: {
        maxLength?: number;
        preserveStructure?: boolean;
        preserveReferences?: boolean;
        conversationFormat?: boolean;
        llmProvider?: string;
        summaryStyle?: string;
        compressionRatio?: number;
        [key: string]: unknown;
    }): void;

    /**
     * Estimate compression ratio for an item without processing
     */
    estimateCompression(item: MemoryItem<unknown>): Promise<{
        originalSize: number;
        estimatedCompressedSize: number;
        compressionRatio: number;
    }>;

    /**
     * Get compression statistics
     */
    getCompressionStats(): {
        totalItemsCompressed: number;
        averageCompressionRatio: number;
        totalBytesReduced: number;
        averageProcessingTimeMs: number;
    };
}; 