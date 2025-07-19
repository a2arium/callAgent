import { IInformationCompressor } from '../../interfaces/IInformationCompressor.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class LLMCompressor implements IInformationCompressor {
    readonly stageName: "acquisition";
    readonly componentName: "compressor";
    readonly stageNumber = 1;
    private logger;
    private metrics;
    private compressionStats;
    private maxLength;
    private preserveStructure;
    private preserveReferences;
    private conversationFormat;
    private llmProvider;
    private summaryStyle;
    private compressionRatio;
    constructor(config?: {
        maxLength?: number;
        preserveStructure?: boolean;
        preserveReferences?: boolean;
        conversationFormat?: boolean;
        llmProvider?: string;
        summaryStyle?: string;
        compressionRatio?: number;
    });
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
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    private compressData;
    private compressText;
    private compressConversation;
    private compressObject;
    estimateCompression(item: MemoryItem<unknown>): Promise<{
        originalSize: number;
        estimatedCompressedSize: number;
        compressionRatio: number;
    }>;
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
    getMetrics(): ProcessorMetrics;
    getCompressionStats(): {
        totalItemsCompressed: number;
        averageCompressionRatio: number;
        totalBytesReduced: number;
        averageProcessingTimeMs: number;
    };
}
