import type { LLMConfig } from '../shared/types/LLMTypes.js';
/**
 * Default LLM configuration
 * This can be overridden by environment variables or explicit settings
 */
export declare const defaultLLMConfig: LLMConfig;
/**
 * Load the LLM configuration with potential overrides
 */
export declare function loadLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig;
