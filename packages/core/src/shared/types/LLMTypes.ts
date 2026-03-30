// src/shared/types/LLMTypes.ts
import {
    LLMCaller,
    UniversalChatResponse,
    UniversalStreamResponse,
    ToolDefinition,
    Usage
} from 'callllm';
import type { LLMCallOptions, LLMSettings } from '../../types/llmContracts.js';

// Re-export library types we'll use directly
export type {
    ToolDefinition,
    Usage,
    UniversalChatResponse,
    UniversalStreamResponse
};

export type LLMMessage = string | Record<string, unknown>;

// Define our framework-specific contract that matches architecture docs
export type ILLMCaller = {
    call<T = unknown>(message: LLMMessage, options?: LLMCallOptions): Promise<UniversalChatResponse<T>[]>;
    stream<T = unknown>(message: LLMMessage, options?: LLMCallOptions): AsyncIterable<UniversalStreamResponse<T>>;
    addToolResult(id: string, result: string, name: string): void;
    updateSettings(settings: LLMSettings): void;
    /** Optional: return current conversation messages; includeSystem=true to include system message */
    getMessages?: (includeSystem?: boolean) => unknown;
    /** Optional: set conversation messages (used on restore) */
    setMessages?: (messages: unknown) => void;
    /** Optional: get current history mode */
    getHistoryMode?: () => 'stateless' | 'dynamic' | 'full';
    /** Optional: clear conversation history */
    clearHistory?: () => void;
    /** Direct MCP tool execution bypasses LLM inference */
    callMcpTool?(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    /** Get available schemas from an MCP server */
    getMcpServerToolSchemas?(serverName: string): Promise<Record<string, unknown>>;
};

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
    call<T = unknown>(message: LLMMessage, options?: LLMCallOptions): Promise<UniversalChatResponse<T>[]>;

    /**
     * Streaming variant (rarely needed in pure modules, but available)
     */
    stream?<T = unknown>(message: LLMMessage, options?: LLMCallOptions): AsyncIterable<UniversalStreamResponse<T>>;
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
    defaultSettings?: LLMSettings;
    mcpServers?: {
        [serverName: string]: {
            command: string;
            args?: string[];
            env?: Record<string, string>;
        } | undefined;
    };
}; 