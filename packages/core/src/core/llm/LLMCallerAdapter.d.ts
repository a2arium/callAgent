import type { UniversalChatResponse, UniversalStreamResponse } from 'callllm';
import { ILLMCaller, LLMConfig } from '../../shared/types/LLMTypes.js';
type RecordUsageFunction = (cost: number | {
    cost: number;
}) => void;
/**
 * Adapter for the callllm library that implements the ILLMCaller interface
 * from our framework architecture.
 */
export declare class LLMCallerAdapter implements ILLMCaller {
    private caller;
    private recordUsage?;
    constructor(config: LLMConfig, recordUsage?: RecordUsageFunction);
    /**
     * Make a non-streaming LLM call
     */
    call<T = unknown>(message: string, options?: Record<string, any>): Promise<UniversalChatResponse<T>[]>;
    /**
     * Make a streaming LLM call
     */
    stream<T = unknown>(message: string, options?: Record<string, any>): AsyncIterable<UniversalStreamResponse<T>>;
    /**
     * Add a tool result for the next call
     */
    addToolResult(id: string, result: string, name: string): void;
    /**
     * Update the default settings for this LLM caller
     */
    updateSettings(settings: Record<string, any>): void;
}
export {};
