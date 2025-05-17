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
    call<T = unknown>(message: string, options?: Record<string, any>): Promise<UniversalChatResponse<T>>;
    stream<T = unknown>(message: string, options?: Record<string, any>): AsyncIterable<UniversalStreamResponse<T>>;
    addToolResult(id: string, result: string, name: string): void;
    updateSettings(settings: Record<string, any>): void;
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