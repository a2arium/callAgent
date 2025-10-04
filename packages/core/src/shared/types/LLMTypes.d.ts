import { UniversalChatResponse, UniversalStreamResponse, ToolDefinition, Usage } from 'callllm';
export type { ToolDefinition, Usage, UniversalChatResponse, UniversalStreamResponse };
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
export type LLMConfig = {
    provider: string;
    modelAliasOrName: string;
    systemPrompt?: string;
    apiKey?: string;
    initialTools?: ToolDefinition[];
    usageCallback?: (usage: Usage) => void;
    historyMode?: 'stateless' | 'dynamic' | 'full';
    defaultSettings?: Record<string, any>;
};
