import type { ILLMCaller, LLMMessage, UniversalChatResponse, UniversalStreamResponse } from '../shared/types/LLMTypes.js';
import type { LLMCallOptions, LLMSettings } from '../types/llmContracts.js';
import { LLMStubResponseSchema, type LLMStubResponse } from './harnessTypes.js';

export type DeterministicLLMStub = ILLMCaller & {
    /** Queue a response for the next call() invocation */
    enqueue<T = unknown>(response: UniversalChatResponse<T> | string): void;
    /** Queue multiple responses */
    enqueueMany<T = unknown>(responses: Array<UniversalChatResponse<T> | string>): void;
    /** Get all calls made to this stub */
    getCalls(): ReadonlyArray<{ message: LLMMessage; options?: LLMCallOptions }>;
    /** Reset the stub (clear queue and call history) */
    reset(): void;
};

export function createDeterministicLLMStub(): DeterministicLLMStub {
    let queue: LLMStubResponse[] = [];
    let calls: Array<{ message: LLMMessage; options?: LLMCallOptions }> = [];
    const toolResults: Array<{ id: string; result: string; name: string }> = [];
    let currentSettings: LLMSettings | undefined;

    const normalizeResponse = (res: any): LLMStubResponse => {
        if (typeof res === 'string') {
            return { content: res, role: 'assistant' };
        }
        return LLMStubResponseSchema.parse({
            content: res.content || '',
            role: res.role || 'assistant',
            contentObject: res.contentObject,
        });
    };

    return {
        enqueue<T = unknown>(response: UniversalChatResponse<T> | string) {
            queue.push(normalizeResponse(response));
        },
        enqueueMany<T = unknown>(responses: Array<UniversalChatResponse<T> | string>) {
            queue.push(...responses.map(normalizeResponse));
        },
        getCalls() {
            return Object.freeze([...calls]);
        },
        reset() {
            queue = [];
            calls = [];
            toolResults.length = 0;
            currentSettings = undefined;
        },

        async call<T = unknown>(message: LLMMessage, options?: LLMCallOptions): Promise<UniversalChatResponse<T>[]> {
            calls.push({ message, options });
            const next = queue.length > 0 ? queue.shift()! : { content: 'default test response', role: 'assistant' };
            
            return [{
                role: next.role as 'assistant',
                content: next.content,
                contentObject: next.contentObject as T | undefined,
            }];
        },

        async *stream<T = unknown>(message: LLMMessage, options?: LLMCallOptions): AsyncIterable<UniversalStreamResponse<T>> {
            calls.push({ message, options });
            const next = queue.length > 0 ? queue.shift()! : { content: 'default test response', role: 'assistant' };
            
            yield {
                role: next.role as 'assistant',
                content: next.content,
                isComplete: true,
                contentObject: next.contentObject as T | undefined,
            };
        },

        addToolResult(id: string, result: string, name: string) {
            toolResults.push({ id, result, name });
        },

        getHistoryMode() {
            return 'stateless' as const;
        },

        updateSettings(settings: LLMSettings) {
            currentSettings = settings;
        }
    };
}

export type DeterministicToolStub = {
    register(toolName: string, result: unknown): void;
    invoke<T = unknown>(toolName: string, args: unknown): Promise<T>;
    getCalls(): ReadonlyArray<{ tool: string; args: unknown }>;
    reset(): void;
};

export function createDeterministicToolStub(): DeterministicToolStub {
    const registry = new Map<string, unknown>();
    let calls: Array<{ tool: string; args: unknown }> = [];

    return {
        register(toolName: string, result: unknown) {
            registry.set(toolName, result);
        },
        async invoke<T = unknown>(toolName: string, args: unknown): Promise<T> {
            calls.push({ tool: toolName, args });
            if (!registry.has(toolName)) {
                throw new Error(`Tool stub for '${toolName}' not registered. Call register() before invoke().`);
            }
            return registry.get(toolName) as T;
        },
        getCalls() {
            return Object.freeze([...calls]);
        },
        reset() {
            registry.clear();
            calls = [];
        }
    };
}
