import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';
/**
 * Reflection processor - generates insights and meta-cognition about memory items
 */
export type IReflection = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'reflection';
    /**
     * Generate reflective insights about memory items
     * @returns Memory item with reflection metadata added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure reflection mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        conversationAware?: boolean;
        trackMisunderstandings?: boolean;
        insightExtraction?: boolean;
        llmProvider?: string;
        [key: string]: unknown;
    }): void;
};
/**
 * Summarization processor - creates concise summaries of memory items
 */
export type ISummarization = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'summarization';
    /**
     * Generate summaries of memory items
     * @returns Memory item with summary added or replaced content
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure summarization mechanism
     */
    configure(config: {
        strategy?: string;
        maxSummaryLength?: number;
        preserveSpeakers?: boolean;
        topicAware?: boolean;
        hierarchicalSummary?: boolean;
        llmProvider?: string;
        placeholder?: boolean;
        [key: string]: unknown;
    }): void;
};
/**
 * Distillation processor - extracts key patterns, rules, and knowledge
 */
export type IDistillation = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'distillation';
    /**
     * Extract distilled knowledge from memory items
     * @returns Memory item with distilled knowledge added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure distillation mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        extractTopics?: boolean;
        trackIntents?: boolean;
        extractRules?: boolean;
        patternRecognition?: boolean;
        [key: string]: unknown;
    }): void;
};
/**
 * Forgetting processor - manages memory decay and removal of outdated information
 */
export type IForgetting = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'forgetting';
    /**
     * Apply forgetting mechanisms to memory items
     * @returns Memory item with updated relevance/decay scores, or null if forgotten
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
    /**
     * Configure forgetting mechanism
     */
    configure(config: {
        decayRate?: number;
        timeWindow?: string;
        retentionThreshold?: number;
        preserveImportantTurns?: boolean;
        similarityDeduplication?: boolean;
        preserveUnique?: boolean;
        placeholder?: boolean;
        [key: string]: unknown;
    }): void;
};
/**
 * Complete derivation stage processor that orchestrates reflection, summarization, distillation, and forgetting
 */
export type IDerivationStage = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly stageNumber: 3;
    reflection: IReflection;
    summarization: ISummarization;
    distillation: IDistillation;
    forgetting: IForgetting;
    /**
     * Process memory item through the complete derivation pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
};
