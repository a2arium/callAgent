import { IInformationCompressor } from '../../interfaces/IInformationCompressor.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
/**
 * Simple text truncation compressor
 * Truncates text content to a maximum length while preserving structure
 */
export declare class TextTruncationCompressor implements IInformationCompressor {
    readonly stageName: "acquisition";
    readonly componentName: "compressor";
    readonly stageNumber = 1;
    private maxLength;
    private preserveStructure;
    private metrics;
    constructor(config?: {
        maxLength?: number;
        preserveStructure?: boolean;
    });
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    getName(): string;
    getVersion(): string;
    getDescription(): string;
    getConfiguration(): Record<string, unknown>;
    configure(config: {
        maxLength?: number;
        preserveStructure?: boolean;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    estimateCompression(item: MemoryItem<unknown>): Promise<{
        originalSize: number;
        estimatedCompressedSize: number;
        compressionRatio: number;
    }>;
    getCompressionStats(): {
        totalItemsCompressed: number;
        averageCompressionRatio: number;
        totalBytesReduced: number;
        averageProcessingTimeMs: number;
    };
}
