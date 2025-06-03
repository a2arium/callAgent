import { LLMConfig } from '../../shared/types/LLMTypes.js';
import { LLMCallerAdapter } from './LLMCallerAdapter.js';
import type { TaskContext } from '../../shared/types/index.js';

/**
 * Configuration for embedding functionality
 */
export type EmbeddingConfig = {
    provider: string;           // e.g., 'openai'
    model: string;             // e.g., 'text-embedding-3-small'
    apiKey?: string;           // Optional, falls back to env vars
    dimensions?: number;       // Optional dimension reduction
    encodingFormat?: 'float' | 'base64';
};

/**
 * Creates an LLM instance for a task context
 * This factory automatically wires up the usage tracking between the LLM and the TaskContext
 */
export function createLLMForTask(config: LLMConfig, ctx: TaskContext): LLMCallerAdapter {
    // Create the adapter with the recordUsage function from the context
    return new LLMCallerAdapter(
        config,
        (cost: number | { cost: number }) => ctx.recordUsage(cost as any)
    );
}

/**
 * Creates an embedding function from environment configuration
 * This function can be used by memory adapters for entity alignment
 */
export async function createEmbeddingFunction(): Promise<(text: string) => Promise<number[]>> {
    const config = getEmbeddingConfigFromEnv();

    if (!config) {
        throw new Error('Embedding configuration not found. Set EMBEDDING_PROVIDER and EMBEDDING_MODEL in environment.');
    }

    // Import callllm dynamically to avoid loading if not needed
    const { LLMCaller } = await import('callllm');

    // Create a dedicated LLM caller for embeddings
    const embeddingCaller = new LLMCaller(
        config.provider as any, // Cast to avoid type issues
        'fast', // Use fast model
        'Assistant', // Dummy system prompt
        {
            apiKey: config.apiKey
        }
    );

    // Return the embedding function
    return async (text: string): Promise<number[]> => {
        try {
            // Handle edge cases where text might be undefined or empty
            if (!text || text === 'undefined' || text === 'null') {
                console.warn('Received invalid text for embedding, skipping');
                return [];
            }

            const response = await embeddingCaller.embeddings({
                input: text,
                model: config.model,
                dimensions: config.dimensions,
                encodingFormat: config.encodingFormat || 'float'
            });

            return response.embeddings[0].embedding;
        } catch (error) {
            console.warn(`Failed to generate embedding for text: "${text?.substring?.(0, 50) || 'invalid text'}..."`, error);
            // Return empty array as fallback to prevent breaking the system
            return [];
        }
    };
}

/**
 * Creates an embedding function with usage tracking
 */
export async function createEmbeddingFunctionWithTracking(
    ctx: TaskContext
): Promise<(text: string) => Promise<number[]>> {
    const config = getEmbeddingConfigFromEnv();

    if (!config) {
        throw new Error('Embedding configuration not found. Set EMBEDDING_PROVIDER and EMBEDDING_MODEL in environment.');
    }

    const { LLMCaller } = await import('callllm');

    const embeddingCaller = new LLMCaller(
        config.provider as any, // Cast to avoid type issues
        'fast',
        'Assistant',
        {
            apiKey: config.apiKey,
            usageCallback: async (usage) => {
                // Track embedding usage in the task context
                // TODO: Fix usage tracking once we know the correct property names
                console.log('Embedding usage:', usage);
                // if (usage.totalCost) {
                //     ctx.recordUsage({ cost: usage.totalCost });
                // }
            }
        }
    );

    return async (text: string): Promise<number[]> => {
        try {
            // Handle edge cases where text might be undefined or empty
            if (!text || text === 'undefined' || text === 'null') {
                console.warn('Received invalid text for embedding, skipping');
                return [];
            }

            const response = await embeddingCaller.embeddings({
                input: text,
                model: config.model,
                dimensions: config.dimensions,
                encodingFormat: config.encodingFormat || 'float'
            });

            return response.embeddings[0].embedding;
        } catch (error) {
            console.warn(`Failed to generate embedding for text: "${text?.substring?.(0, 50) || 'invalid text'}..."`, error);
            return [];
        }
    };
}

/**
 * Get embedding configuration from environment variables
 */
function getEmbeddingConfigFromEnv(): EmbeddingConfig | null {
    const provider = process.env.EMBEDDING_PROVIDER;
    const model = process.env.EMBEDDING_MODEL;

    if (!provider || !model) {
        return null;
    }

    return {
        provider,
        model,
        apiKey: process.env.OPENAI_API_KEY, // Could be extended for other providers
        dimensions: process.env.EMBEDDING_DIMENSIONS ?
            parseInt(process.env.EMBEDDING_DIMENSIONS) : undefined,
        encodingFormat: (process.env.EMBEDDING_FORMAT as 'float' | 'base64') || 'float'
    };
}

/**
 * Check if embedding functionality is available
 */
export function isEmbeddingAvailable(): boolean {
    return getEmbeddingConfigFromEnv() !== null;
}

/**
 * Get the current embedding model being used
 */
export function getEmbeddingModel(): string | null {
    const config = getEmbeddingConfigFromEnv();
    return config?.model || null;
} 