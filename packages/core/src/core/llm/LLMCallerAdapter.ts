import { LLMCaller } from 'callllm';
import type {
    UniversalChatResponse,
    UniversalStreamResponse,
    ToolDefinition,
    Usage
} from 'callllm';
import { ILLMCaller, LLMConfig } from '../../shared/types/LLMTypes.js';

// Type for the recordUsage function that accepts a cost parameter
type RecordUsageFunction = (cost: number | { cost: number }) => void;

/**
 * Adapter for the callllm library that implements the ILLMCaller interface
 * from our framework architecture.
 */
export class LLMCallerAdapter implements ILLMCaller {
    private caller: LLMCaller;
    private recordUsage?: RecordUsageFunction;

    constructor(config: LLMConfig, recordUsage?: RecordUsageFunction) {
        // Store the recordUsage function for later use
        this.recordUsage = recordUsage;

        // Define the usage callback that will automatically track costs
        const usageCallback = config.usageCallback || (this.recordUsage ?
            (usage: Usage) => {
                if (usage.costs?.total && this.recordUsage) {
                    this.recordUsage({ cost: usage.costs.total });
                }
            } : undefined);

        // Initialize the LLMCaller from the callllm library
        // Note: Cast to 'any' to bypass TypeScript's strict checking on the constructor
        // In a real implementation, we would need to ensure our types exactly match callllm
        this.caller = new (LLMCaller as any)(
            config.provider,
            config.modelAliasOrName,
            config.systemPrompt || 'You are a helpful assistant.',
            {
                apiKey: config.apiKey, // If undefined, callllm will use environment variables
                historyMode: config.historyMode, // Pass the historyMode setting if provided
                usageCallback // Set the usageCallback if provided to automatically track usage
            }
        );

        // Apply any default settings
        if (config.defaultSettings) {
            this.caller.updateSettings(config.defaultSettings);
        }

        // Register initial tools if provided
        if (config.initialTools && config.initialTools.length > 0) {
            this.caller.addTools(config.initialTools);
        }
    }

    /**
     * Make a non-streaming LLM call
     */
    async call<T = unknown>(
        message: string,
        options?: Record<string, any>
    ): Promise<UniversalChatResponse<T>[]> {
        try {
            // Pass through to the callllm library
            // Return the full array of responses from call()
            const responses = await this.caller.call(message, options) as UniversalChatResponse<unknown>[];
            const typedResponses = responses as UniversalChatResponse<T>[];

            // Automatically record usage if not using the callback approach
            // and we have a recordUsage function available
            // Combine costs from all responses
            if (!options?.usageCallback && this.recordUsage && responses.length > 0) {
                let totalCost = 0;
                for (const response of responses) {
                    if (response.metadata?.usage?.costs?.total) {
                        totalCost += response.metadata.usage.costs.total;
                    }
                }
                if (totalCost > 0) {
                    this.recordUsage({ cost: totalCost });
                }
            }

            return typedResponses;
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
                // If this is the final chunk and we're not using callbacks, record the usage
                if (chunk.isComplete && !options?.usageCallback && this.recordUsage &&
                    chunk.metadata?.usage?.costs?.total) {
                    this.recordUsage({ cost: chunk.metadata.usage.costs.total });
                }

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