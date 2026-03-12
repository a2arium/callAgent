// src/shared/types/LLMTypes.ts
import {
    LLMCaller,
    UniversalChatResponse,
    UniversalStreamResponse,
    ToolDefinition,
    Usage
} from 'callllm';

// Re-export library types we'll use directly
export type {
    ToolDefinition,
    Usage,
    UniversalChatResponse,
    UniversalStreamResponse
};

// Define our framework-specific interface that matches architecture docs
export interface ILLMCaller {
    call<T = unknown>(message: string, options?: Record<string, any>): Promise<UniversalChatResponse<T>[]>;
    stream<T = unknown>(message: string, options?: Record<string, any>): AsyncIterable<UniversalStreamResponse<T>>;
    addToolResult(id: string, result: string, name: string): void;
    updateSettings(settings: Record<string, any>): void;
    /** Optional: return current conversation messages; includeSystem=true to include system message */
    getMessages?: (includeSystem?: boolean) => unknown;
    /** Optional: set conversation messages (used on restore) */
    setMessages?: (messages: unknown) => void;
}

/**
 * A sealed interface for making LLM generation calls.
 *
 * This port is designed for internal sub-components within the `Execution` module
 * that need to perform inference but do not need access to the full `TaskContext`.
 *
 * Example:
 * ```ts
 * // Inside an Execution tool handler:
 * async function summarize(text: string, llm: PureLLMPort) {
 *     const res = await llm.call(`Summarize: ${text}`);
 *     return res[0]?.content;
 * }
 * ```
 * Best practices when using in pure modules:
 * - Use temperature=0 for best-effort determinism
 * - Use structured outputs with JSON schema validation
 * - Pin model versions for replay (done via agent config)
 * - Validate all LLM outputs with JSON Schema before trusting them
 * - Always provide fallback logic for when LLM calls fail
 */
export type PureLLMPort = {
    /**
     * Make a non-streaming LLM call for normalization/extraction
     * Returns structured responses - validate with JSON Schema afterward
     */
    call<T = unknown>(message: string, options?: {
        /** Temperature (prefer 0 for determinism) */
        temperature?: number;
        /** JSON schema for structured output */
        schema?: Record<string, unknown>;
        /** Model-specific seed for determinism */
        seed?: number;
        /** Other model-specific options */
        [key: string]: unknown;
    }): Promise<UniversalChatResponse<T>[]>;

    /**
     * Streaming variant (rarely needed in pure modules, but available)
     */
    stream?<T = unknown>(message: string, options?: Record<string, unknown>): AsyncIterable<UniversalStreamResponse<T>>;
};

// Configuration for LLM integration
export type LLMConfig = {
    provider: string;
    modelAliasOrName: string;
    systemPrompt?: string;
    apiKey?: string;
    initialTools?: ToolDefinition[];
    usageCallback?: (usage: Usage) => void;
    historyMode?: 'stateless' | 'dynamic' | 'full';
    defaultSettings?: Record<string, any>; // Match library settings type
}; 