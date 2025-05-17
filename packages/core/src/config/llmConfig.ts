import type { LLMConfig } from '../shared/types/LLMTypes.js';

/**
 * Default LLM configuration 
 * This can be overridden by environment variables or explicit settings
 */
export const defaultLLMConfig: LLMConfig = {
    // Provider can be 'openai' or other supported providers as they're added
    provider: process.env.DEFAULT_LLM_PROVIDER || 'openai',

    // Can be a direct model name like 'gpt-4o-mini' or an alias like 'fast', 'balanced'
    modelAliasOrName: process.env.DEFAULT_LLM_MODEL || 'fast',

    // Default system prompt
    systemPrompt: process.env.DEFAULT_LLM_SYSTEM_PROMPT || 'You are a helpful AI assistant.',

    // API key can be provided here or via environment variables (e.g., OPENAI_API_KEY)
    // callllm will automatically use the correct environment variable based on the provider
    apiKey: process.env.LLM_API_KEY,

    // Default settings that will be applied to all calls unless overridden
    defaultSettings: {
        temperature: parseFloat(process.env.DEFAULT_LLM_TEMPERATURE || '0.7'),
        maxRetries: parseInt(process.env.DEFAULT_LLM_MAX_RETRIES || '3', 10),
        historyMode: process.env.DEFAULT_LLM_HISTORY_MODE || 'stateless'
    }
};

/**
 * Load the LLM configuration with potential overrides
 */
export function loadLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
    return {
        ...defaultLLMConfig,
        ...overrides,
        // Merge settings if both exist
        defaultSettings: {
            ...defaultLLMConfig.defaultSettings,
            ...(overrides?.defaultSettings || {})
        }
    };
} 