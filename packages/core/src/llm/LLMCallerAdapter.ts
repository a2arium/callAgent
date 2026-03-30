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
import type { ILLMCaller, LLMConfig, LLMMessage } from '../shared/types/LLMTypes.js';
import type { LLMCallOptions, LLMSettings } from '../types/llmContracts.js';
import type { UsageRecord } from '../shared/types/index.js';
import type { InternalTaskContext } from '../loop/internalContext.js';

// Type for the recordUsage function that accepts our detailed record
type RecordUsageFunction = (cost: number | UsageRecord) => void;

/** callllm Usage tokens can be number or { total?: number }. */
function usageTokensInput(usage: Usage | undefined): number | undefined {
    const t = usage?.tokens?.input;
    return typeof t === 'number' ? t : t?.total;
}

function usageTokensOutput(usage: Usage | undefined): number | undefined {
    const t = usage?.tokens?.output;
    return typeof t === 'number' ? t : t?.total;
}

/** callllm LLMCaller may expose optional MCP/history methods. */
type LLMCallerExtended = LLMCaller & {
    callMcpTool?: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
    getMcpServerToolSchemas?: (server: string) => Promise<Record<string, unknown>>;
    getMessages?: (includeSystem?: boolean) => unknown;
    getHistoryMode?: () => 'stateless' | 'dynamic' | 'full';
    clearHistory?: () => void;
    setMessages?: (messages: unknown) => void;
    history?: unknown[];
    messages?: unknown[];
    _history?: unknown[];
};

/** ProviderInit env: empty to avoid callllm loading Opik/OTel; we export via callagent. */
const EMPTY_ENV = {} as Record<string, string | undefined>;

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
                        tokens: (usage?.tokens != null) ? { input: usageTokensInput(usage), output: usageTokensOutput(usage) } : undefined
                    };
                    this.recordUsage(record);
                }
            } : undefined);

        // Create bridge provider for telemetry integration
        this.bridgeProvider = new CallagentBridgeProvider('root');
        if (ctx) {
            this.bridgeProvider.setContextRef(ctx as InternalTaskContext);
        }

        const callllmTelemetryCollector = new CallLLMTelemetryCollector({
            providers: [this.bridgeProvider],
            env: EMPTY_ENV as NodeJS.ProcessEnv
        });

        const initialTools: ToolDefinition[] = config.initialTools ?? [];
        const combinedTools: (ToolDefinition | unknown)[] = [...initialTools];
        if (config.mcpServers != null) {
            combinedTools.push(config.mcpServers);
        }

        // callllm LLMCallerOptions.usageCallback uses UsageData; our callback uses Usage. Cast for compatibility.
        type CallLLMOptions = import('callllm').LLMCallerOptions;
        this.caller = new LLMCaller(
            config.provider as 'openai' | 'cerebras' | 'venice' | 'openrouter',
            config.modelAliasOrName,
            config.systemPrompt || 'You are a helpful assistant.',
            {
                apiKey: config.apiKey,
                historyMode: config.historyMode,
                usageCallback,
                telemetryCollector: callllmTelemetryCollector,
                tools: combinedTools
            } as CallLLMOptions
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
        message: LLMMessage,
        options?: LLMCallOptions
    ): Promise<UniversalChatResponse<T>[]> {
        // Set the parent node ID and context for telemetry - bridge will create LLMNode as child and accumulate turn summaries
        try {
            const parentId = options?.telemetryNodeId || this.ctx?.telemetry?.nodeId;
            if (parentId && this.bridgeProvider) {
                this.bridgeProvider.setParentNodeId(parentId, this.ctx ?? null);
            }
        } catch (e) { /* ignore telemetry setup errors */ }

        try {
            // Pass through to the callllm library
            // Return the full array of responses from call()
            const callMessage = this.toCallLLMMessage(message, options);
            const responses = await this.caller.call(callMessage) as UniversalChatResponse<unknown>[];
            const typedResponses = responses as UniversalChatResponse<T>[];

            if (options?.jsonSchema) {
                for (const response of typedResponses) {
                    const hasStructuredOutput = response.contentObject != null;
                    const metadata = response.metadata ?? {};
                    response.metadata = {
                        ...metadata,
                        validationErrors: hasStructuredOutput
                            ? metadata.validationErrors
                            : [
                                ...(metadata.validationErrors ?? []),
                                {
                                    path: ['contentObject'],
                                    message: 'Structured output missing for contracted response',
                                },
                            ],
                    };
                }
            }

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
                        const meta = response.metadata as { usage?: Usage } | undefined;
                        tokensIn += Number(usageTokensInput(meta?.usage) ?? 0);
                        tokensOut += Number(usageTokensOutput(meta?.usage) ?? 0);
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
        message: LLMMessage,
        options?: LLMCallOptions
    ): AsyncIterable<UniversalStreamResponse<T>> {
        // Set the parent node ID and context for telemetry - bridge will create LLMNode as child and accumulate turn summaries
        try {
            const parentId = options?.telemetryNodeId || this.ctx?.telemetry?.nodeId;
            if (parentId && this.bridgeProvider) {
                this.bridgeProvider.setParentNodeId(parentId, this.ctx ?? null);
            }
        } catch (e) { /* ignore */ }

        try {
            // Call the underlying library's stream method
            const callMessage = this.toCallLLMMessage(message, options);
            for await (const chunk of this.caller.stream(callMessage)) {
                // If this is the final chunk and we're not using callbacks, record the usage
                if (chunk.isComplete && !options?.usageCallback && this.recordUsage &&
                    (chunk.metadata?.usage?.costs?.total)) {
                    const usage = (chunk.metadata as { usage?: Usage }).usage;
                    const record: UsageRecord = {
                        cost: chunk.metadata.usage.costs.total,
                        kind: 'llm',
                        op: 'stream',
                        provider: this.provider,
                        model: this.modelName,
                        tokens: usage ? { input: usageTokensInput(usage), output: usageTokensOutput(usage) } : undefined
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
    updateSettings(settings: LLMSettings): void {
        this.caller.updateSettings(settings as Record<string, unknown>);
    }

    /**
     * Execute an MCP tool directly, bypassing the LLM
     */
    async callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        const ext = this.caller as LLMCallerExtended;
        if (typeof ext.callMcpTool === 'function') {
            return ext.callMcpTool(serverName, toolName, args);
        }
        throw new Error('Underlying LLMCaller does not support callMcpTool');
    }

    async getMcpServerToolSchemas(serverName: string): Promise<Record<string, unknown>> {
        const ext = this.caller as LLMCallerExtended;
        if (typeof ext.getMcpServerToolSchemas === 'function') {
            const out = await ext.getMcpServerToolSchemas(serverName);
            return (Array.isArray(out) ? { tools: out } : out) as Record<string, unknown>;
        }
        throw new Error('Underlying LLMCaller does not support getMcpServerToolSchemas');
    }

    getMessages(includeSystem?: boolean): unknown {
        const ext = this.caller as LLMCallerExtended;
        if (typeof ext.getMessages === 'function') return ext.getMessages(includeSystem === true);
        return undefined;
    }

    getHistoryMode(): 'stateless' | 'dynamic' | 'full' {
        const ext = this.caller as LLMCallerExtended;
        if (typeof ext.getHistoryMode === 'function') return ext.getHistoryMode();
        return 'full';
    }

    clearHistory(): void {
        const ext = this.caller as LLMCallerExtended;
        if (typeof ext.clearHistory === 'function') {
            ext.clearHistory();
        } else {
            this.setMessages([]);
        }
    }

    setMessages(messages: unknown): void {
        const ext = this.caller as LLMCallerExtended;
        try {
            const normalized = this.normalizeMessages(messages);
            if (typeof ext.setMessages === 'function') {
                ext.setMessages(normalized);
            } else if (Array.isArray(normalized)) {
                if (Array.isArray(ext.history)) ext.history = normalized;
                else if (Array.isArray(ext.messages)) ext.messages = normalized;
                else if (Array.isArray(ext._history)) ext._history = normalized;
            }
        } catch { /* swallow */ }
    }

    exportState(): unknown {
        try {
            const ext = this.caller as LLMCallerExtended;
            if (typeof ext.getMessages === 'function') {
                const messages = ext.getMessages(true);
                return { messages };
            }
        } catch { /* ignore */ }
        return undefined;
    }

    importState(state: unknown): void {
        try {
            const ext = this.caller as LLMCallerExtended;
            const s = state as { messages?: unknown };
            if (s?.messages != null) {
                const normalized = this.normalizeMessages(s.messages);
                if (typeof ext.setMessages === 'function') {
                    ext.setMessages(normalized);
                }
            }
        } catch { /* ignore */ }
    }

    private normalizeMessages(messages: unknown): Array<{ role: string; content: string }> | unknown {
        try {
            const wrap = messages as { messages?: unknown } | null;
            const raw = (wrap && wrap.messages != null) ? wrap.messages : messages;
            if (!Array.isArray(raw)) return raw;
            return raw.map((m: Record<string, unknown>) => {
                const role = (m?.role ?? m?.speaker ?? 'assistant') as string;
                let content = '';
                if (typeof m?.content === 'string') content = m.content;
                else if (Array.isArray(m?.content)) {
                    const first = (m.content as Array<{ text?: string }>).find(p => typeof p?.text === 'string');
                    content = typeof first?.text === 'string' ? first.text : JSON.stringify(m.content);
                } else if (typeof m?.text === 'string') content = m.text;
                else if (Array.isArray((m as { parts?: unknown[] }).parts)) {
                    const parts = (m as { parts: Array<{ text?: string }> }).parts;
                    const first = parts.find(p => typeof p?.text === 'string');
                    content = typeof first?.text === 'string' ? first.text : JSON.stringify(parts);
                } else if (m?.message != null) content = String(m.message);
                return { role: String(role), content };
            });
        } catch {
            return messages;
        }
    }

    private toCallLLMMessage(message: LLMMessage, options?: LLMCallOptions): string | Record<string, unknown> {
        if (typeof message === 'string') {
            return options != null ? { ...options, text: message } : message;
        }
        return options != null ? { ...options, ...message } : message;
    }
}