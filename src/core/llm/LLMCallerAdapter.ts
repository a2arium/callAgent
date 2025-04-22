import { LLMCaller } from 'callllm';
import type {
    UniversalChatResponse,
    UniversalStreamResponse,
    ToolDefinition,
    Usage
} from 'callllm';
import { ILLMCaller, LLMConfig } from '../../shared/types/LLMTypes.js';

/**
 * Adapter for the callllm library that implements the ILLMCaller interface
 * from our framework architecture.
 */
export class LLMCallerAdapter implements ILLMCaller {
    private caller: LLMCaller;

    constructor(config: LLMConfig) {
        // Initialize the LLMCaller from the callllm library
        // Note: Cast to 'any' to bypass TypeScript's strict checking on the constructor
        // In a real implementation, we would need to ensure our types exactly match callllm
        this.caller = new (LLMCaller as any)(
            config.provider,
            config.modelAliasOrName,
            config.systemPrompt || 'You are a helpful assistant.',
            config.apiKey // If undefined, callllm will use environment variables
        );

        // Apply any default settings
        if (config.defaultSettings) {
            this.caller.updateSettings(config.defaultSettings);
        }

        // Register initial tools if provided
        if (config.initialTools && config.initialTools.length > 0) {
            this.caller.addTools(config.initialTools);
        }

        // Set up usage tracking callback if provided
        if (config.usageCallback) {
            // We'd need to check the callllm documentation to see how to set this
            // This might require setting it in options per call if not configurable on the LLMCaller instance
        }
    }

    /**
     * Make a non-streaming LLM call
     */
    async call<T = unknown>(
        message: string,
        options?: Record<string, any>
    ): Promise<UniversalChatResponse<T>> {
        try {
            // Pass through to the callllm library
            // Get the first response from the array returned by call()
            const responses = await this.caller.call(message, options) as UniversalChatResponse<unknown>[];
            return responses[0] as UniversalChatResponse<T>;
        } catch (error) {
            // Handle errors according to framework standards
            console.error('LLM call error:', error);
            throw error; // In a full implementation, map to framework error types
        }
    }

    /**
     * Make a streaming LLM call
     */
    async *stream<T = unknown>(
        message: string,
        options?: Record<string, any>
    ): AsyncIterable<UniversalStreamResponse<T>> {
        try {
            // Call the underlying library's stream method
            for await (const chunk of this.caller.stream(message, options)) {
                // We need to verify that callllm's StreamResponse matches our expected type
                yield chunk as UniversalStreamResponse<T>;
            }
        } catch (error) {
            console.error('LLM stream error:', error);
            throw error; // In a full implementation, map to framework error types
        }
    }

    /**
     * Add a tool result for the next call
     */
    addToolResult(id: string, result: string, name: string): void {
        this.caller.addToolResult(id, result, name);
    }

    /**
     * Update the default settings for this LLM caller
     */
    updateSettings(settings: Record<string, any>): void {
        this.caller.updateSettings(settings);
    }
} 