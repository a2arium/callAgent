import { LLMCaller, TelemetryCollector as CallLLMTelemetryCollector } from 'callllm';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { CallagentBridgeProvider } from '../telemetry/providers/CallagentBridgeProvider.js';
import type { TaskContext } from '../shared/types/index.js';
import type {
    UniversalChatResponse,
    UniversalStreamResponse,
    ToolDefinition,
    Usage
} from 'callllm';
import { ILLMCaller, LLMConfig } from '../shared/types/LLMTypes.js';
import type { UsageRecord } from '../shared/types/index.js';

// Type for the recordUsage function that accepts our detailed record
type RecordUsageFunction = (cost: number | UsageRecord) => void;

/**
 * Adapter for the callllm library that implements the ILLMCaller interface
 * from our framework architecture.
 */
export class LLMCallerAdapter implements ILLMCaller {
    private caller: LLMCaller;
    private recordUsage?: RecordUsageFunction;
    private provider?: string;
    private modelName?: string;
    private ctx?: TaskContext;
    private bridgeProvider?: CallagentBridgeProvider;

    constructor(config: LLMConfig, recordUsage?: RecordUsageFunction, ctx?: TaskContext) {
        // Store the recordUsage function for later use
        this.ctx = ctx;
        this.recordUsage = recordUsage;
        this.provider = config.provider;
        this.modelName = config.modelAliasOrName;

        // Define the usage callback that will automatically track costs
        const usageCallback = config.usageCallback || (this.recordUsage ?
            (usage: Usage) => {
                if (usage.costs?.total && this.recordUsage) {
                    const record: UsageRecord = {
                        cost: usage.costs.total,
                        kind: 'llm',
                        op: 'call',
                        provider: this.provider,
                        model: this.modelName,
                        tokens: (usage as any)?.tokens ? { input: (usage as any)?.tokens?.input, output: (usage as any)?.tokens?.output } : undefined
                    };
                    this.recordUsage(record);
                }
            } : undefined);

        // Create bridge provider for telemetry integration
        // The bridge forwards callLLM telemetry events to callagent's telemetry system
        this.bridgeProvider = new CallagentBridgeProvider('root');

        const callllmTelemetryCollector = new CallLLMTelemetryCollector({
            providers: [this.bridgeProvider],
            env: {} as any // Prevent auto-loading Opik/OTel - callagent handles telemetry export
        });


        // Prepare tools array
        const initialTools = config.initialTools || [];
        const combinedTools = [...initialTools];

        if (config.mcpServers) {
            combinedTools.push(config.mcpServers as any);
        }

        // Initialize the LLMCaller from the callllm library
        this.caller = new LLMCaller(
            config.provider as any,
            config.modelAliasOrName,
            config.systemPrompt || 'You are a helpful assistant.',
            {
                apiKey: config.apiKey, // If undefined, callllm will use environment variables
                historyMode: config.historyMode, // Pass the historyMode setting if provided
                usageCallback: usageCallback as any, // Cast: Usage shape differs between callagent-core and callllm
                telemetryCollector: callllmTelemetryCollector, // Use bridge for telemetry
                tools: combinedTools // Pass initial tools array
            }
        );

        // Apply any default settings
        if (config.defaultSettings) {
            this.caller.updateSettings(config.defaultSettings);
        }
    }

    /**
     * Make a non-streaming LLM call
     */
    async call<T = unknown>(
        message: string | any,
        options?: Record<string, any>
    ): Promise<UniversalChatResponse<T>[]> {
        // Set the parent node ID for telemetry - bridge will create LLMNode as child
        try {
            const parentId = options?.telemetryNodeId || this.ctx?.telemetry?.nodeId;
            if (parentId && this.bridgeProvider) {
                this.bridgeProvider.setParentNodeId(parentId);
            }
        } catch (e) { /* ignore telemetry setup errors */ }

        try {
            // Pass through to the callllm library
            // Return the full array of responses from call()
            const responses = await this.caller.call(message, options) as UniversalChatResponse<unknown>[];
            const typedResponses = responses as UniversalChatResponse<T>[];

            // Automatically record usage if not using the callback approach
            if (!options?.usageCallback && this.recordUsage && responses.length > 0) {
                let totalCost = 0;
                let tokensIn = 0;
                let tokensOut = 0;
                for (const response of responses) {
                    if (response.metadata?.usage?.costs?.total) {
                        totalCost += response.metadata.usage.costs.total;
                    }
                    try {
                        tokensIn += Number((response.metadata as any)?.usage?.tokens?.input || 0);
                        tokensOut += Number((response.metadata as any)?.usage?.tokens?.output || 0);
                    } catch { /* noop */ }
                }
                if (totalCost > 0) {
                    const record: UsageRecord = {
                        cost: totalCost,
                        kind: 'llm',
                        op: 'call',
                        provider: this.provider,
                        model: this.modelName,
                        tokens: (tokensIn || tokensOut) ? { input: tokensIn || undefined, output: tokensOut || undefined } : undefined
                    };
                    this.recordUsage(record);
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
        message: string | any,
        options?: Record<string, any>
    ): AsyncIterable<UniversalStreamResponse<T>> {
        // Set the parent node ID for telemetry - bridge will create LLMNode as child
        try {
            const parentId = options?.telemetryNodeId || this.ctx?.telemetry?.nodeId;
            if (parentId && this.bridgeProvider) {
                this.bridgeProvider.setParentNodeId(parentId);
            }
        } catch (e) { /* ignore */ }

        try {
            // Call the underlying library's stream method
            for await (const chunk of this.caller.stream(message, options)) {
                // If this is the final chunk and we're not using callbacks, record the usage
                if (chunk.isComplete && !options?.usageCallback && this.recordUsage &&
                    (chunk.metadata?.usage?.costs?.total)) {
                    const record: UsageRecord = {
                        cost: chunk.metadata.usage.costs.total,
                        kind: 'llm',
                        op: 'stream',
                        provider: this.provider,
                        model: this.modelName,
                        tokens: (chunk.metadata as any)?.usage?.tokens ? { input: (chunk.metadata as any)?.usage?.tokens?.input, output: (chunk.metadata as any)?.usage?.tokens?.output } : undefined
                    };
                    this.recordUsage(record);
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

    /**
     * Execute an MCP tool directly, bypassing the LLM
     */
    async callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        if (typeof (this.caller as any).callMcpTool === 'function') {
            return (this.caller as any).callMcpTool(serverName, toolName, args);
        }
        throw new Error('Underlying LLMCaller does not support callMcpTool');
    }

    /**
     * Get JSON schemas for tools provided by an MCP server
     */
    async getMcpServerToolSchemas(serverName: string): Promise<Record<string, unknown>> {
        if (typeof (this.caller as any).getMcpServerToolSchemas === 'function') {
            return (this.caller as any).getMcpServerToolSchemas(serverName);
        }
        throw new Error('Underlying LLMCaller does not support getMcpServerToolSchemas');
    }

    getMessages(includeSystem?: boolean): unknown {
        const anyCaller = this.caller as any;
        if (typeof anyCaller.getMessages === 'function') return anyCaller.getMessages(includeSystem === true);
        return undefined;
    }

    setMessages(messages: unknown): void {
        const anyCaller = this.caller as any;
        try {
            const normalized = this.normalizeMessages(messages);
            if (typeof anyCaller.setMessages === 'function') {
                anyCaller.setMessages(normalized);
            } else {
                // Fallback: attempt to set a known internal history container
                if (Array.isArray(normalized)) {
                    if (Array.isArray(anyCaller.history)) {
                        anyCaller.history = normalized;
                        // minimal fallback
                    } else if (Array.isArray(anyCaller.messages)) {
                        anyCaller.messages = normalized;
                        // minimal fallback
                    } else if (Array.isArray(anyCaller._history)) {
                        anyCaller._history = normalized;
                        // minimal fallback
                    } else {
                        // no-op
                    }
                }
            }
        } catch (e) {
            // swallow
        }
    }

    // Persistence uses provider-native messages only
    exportState(): unknown {
        try {
            const anyCaller = this.caller as any;
            if (typeof anyCaller.getMessages === 'function') {
                const messages = anyCaller.getMessages(true);
                try { console.log(`[LLMAdapter] exportState messages count: ${Array.isArray(messages) ? messages.length : 'n/a'}`); } catch { }
                return { messages };
            }
        } catch { /* ignore */ }
        return undefined;
    }

    importState(state: unknown): void {
        try {
            const anyCaller = this.caller as any;
            if ((state as any)?.messages) {
                const msgs = (state as any).messages;
                const normalized = this.normalizeMessages(msgs);
                if (typeof this.setMessages === 'function') {
                    this.setMessages(normalized);
                } else if (typeof anyCaller.setMessages === 'function') {
                    anyCaller.setMessages(normalized);
                } else {
                    // no-op
                }
            }
        } catch { /* ignore */ }
    }

    // Normalize messages into an array of { role: string; content: string }
    private normalizeMessages(messages: unknown): Array<{ role: string; content: string }> | unknown {
        try {
            const raw = (messages && (messages as any).messages) ? (messages as any).messages : messages;
            if (!Array.isArray(raw)) return raw as any;
            const normalized = raw.map((m: any) => {
                const role = m?.role ?? m?.speaker ?? 'assistant';
                // Common shapes: { content: string } or { content: [{ type, text }] } or { text }
                let content: string = '';
                if (typeof m?.content === 'string') content = m.content;
                else if (Array.isArray(m?.content)) {
                    const firstText = m.content.find((p: any) => typeof p?.text === 'string')?.text;
                    content = typeof firstText === 'string' ? firstText : JSON.stringify(m.content);
                } else if (typeof m?.text === 'string') content = m.text;
                else if (m?.parts && Array.isArray(m.parts)) {
                    const firstText = m.parts.find((p: any) => typeof p?.text === 'string')?.text;
                    content = typeof firstText === 'string' ? firstText : JSON.stringify(m.parts);
                } else if (m?.message) content = String(m.message);
                else content = '';
                return { role: String(role), content: String(content) };
            });
            return normalized;
        } catch {
            return messages as any;
        }
    }
}