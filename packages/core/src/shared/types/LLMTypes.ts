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
    call<T = unknown>(message: string | any, options?: Record<string, any>): Promise<UniversalChatResponse<T>[]>;
    stream<T = unknown>(message: string | any, options?: Record<string, any>): AsyncIterable<UniversalStreamResponse<T>>;
    addToolResult(id: string, result: string, name: string): void;
    updateSettings(settings: Record<string, any>): void;
    /** Optional: return current conversation messages; includeSystem=true to include system message */
    getMessages?: (includeSystem?: boolean) => unknown;
    /** Optional: set conversation messages (used on restore) */
    setMessages?: (messages: unknown) => void;
}

/**
 * Pure LLM port for use in pure modules (Perception, Shield, etc.)
 * 
 * This sealed interface provides ONLY LLM inference capabilities - no tools,
 * no message manipulation, no side effects beyond usage tracking (observability).
 * 
 * Usage tracking is maintained for cost monitoring but doesn't violate purity.
 * The outputs are still deterministic given the same inputs (when temp=0, seed is set).
 * 
 * Best practices when using in pure modules:
 * - Use temperature=0 for best-effort determinism
 * - Use structured outputs with JSON schema validation
 * - Pin model versions for replay (done via agent config)
 * - Validate all LLM outputs with JSON Schema before trusting them
 * - Always provide fallback logic for when LLM calls fail
 * 
 * Architectural principle:
 * Perception/Shield remain pure transformers. Whether they use regex or LLM
 * is an implementation detail. The module signature stays the same - they accept
 * inputs and return outputs without side effects (usage tracking is observability).
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

/**
 * Extract a pure LLM port from TaskContext
 * This creates a sealed interface that prevents access to ctx capabilities
 */
export function extractPureLLMPort(ctx: { llm: ILLMCaller }): PureLLMPort {
    return {
        call: ctx.llm.call.bind(ctx.llm),
        stream: ctx.llm.stream?.bind(ctx.llm)
    };
}

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