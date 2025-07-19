import { LLMConfig } from '../../shared/types/LLMTypes.js';
import { LLMCallerAdapter } from './LLMCallerAdapter.js';
import type { TaskContext } from '../../shared/types/index.js';
/**
 * Configuration for embedding functionality
 */
export type EmbeddingConfig = {
    provider: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
    encodingFormat?: 'float' | 'base64';
};
/**
 * Creates an LLM instance for a task context
 * This factory automatically wires up the usage tracking between the LLM and the TaskContext
 */
export declare function createLLMForTask(config: LLMConfig, ctx: TaskContext): LLMCallerAdapter;
/**
 * Creates an embedding function from environment configuration
 * This function can be used by memory adapters for entity alignment
 */
export declare function createEmbeddingFunction(): Promise<(text: string) => Promise<number[]>>;
/**
 * Creates an embedding function with usage tracking
 */
export declare function createEmbeddingFunctionWithTracking(ctx: TaskContext): Promise<(text: string) => Promise<number[]>>;
/**
 * Check if embedding functionality is available
 */
export declare function isEmbeddingAvailable(): boolean;
/**
 * Get the current embedding model being used
 */
export declare function getEmbeddingModel(): string | null;
