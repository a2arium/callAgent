import { describe, expect, it, jest } from '@jest/globals';
import { LLMCallerAdapter } from '../src/llm/LLMCallerAdapter.js';
import {
    LLMCancelledError,
    LLMTimeoutError,
} from '../src/types/llmErrors.js';

type FakeCaller = {
    call: jest.Mock<(message: string | Record<string, unknown>) => Promise<unknown[]>>;
    stream: jest.Mock<(message: string | Record<string, unknown>) => AsyncIterable<unknown>>;
};

function createAdapter(fake: Partial<FakeCaller>, ctx?: Record<string, unknown>): LLMCallerAdapter {
    const adapter = new LLMCallerAdapter({
        provider: 'openai',
        modelAliasOrName: 'gpt-test',
        apiKey: 'test',
        historyMode: 'stateless',
    }, undefined, ctx as never);
    Object.assign(adapter as unknown as { caller: Partial<FakeCaller> }, { caller: fake });
    return adapter;
}

describe('LLMCallerAdapter cancellation contract', () => {
    it('forwards timeout and signal to callllm and maps timeout errors', async () => {
        const controller = new AbortController();
        const call = jest.fn(async (message: string | Record<string, unknown>) => {
            expect(message).toMatchObject({ text: 'test', timeoutMs: 50 });
            expect((message as Record<string, unknown>).signal).toBe(controller.signal);
            throw Object.assign(new Error('upstream timeout'), {
                code: 'LLM_TIMEOUT',
                timeoutMs: 50,
            });
        });
        const adapter = createAdapter({ call });

        await adapter.call('test', {
            signal: controller.signal,
            timeoutMs: 50,
        }).catch((error: unknown) => {
            expect(error).toBeInstanceOf(LLMTimeoutError);
            expect(error).toMatchObject({ code: 'LLM_TIMEOUT', timeoutMs: 50 });
        });
    });

    it('keeps explicit execution controls authoritative over message data', async () => {
        const payloadController = new AbortController();
        const optionController = new AbortController();
        const call = jest.fn(async (message: string | Record<string, unknown>) => {
            expect((message as Record<string, unknown>).signal).toBe(optionController.signal);
            expect((message as Record<string, unknown>).timeoutMs).toBe(50);
            return [];
        });
        const adapter = createAdapter({ call });

        await adapter.call({
            text: 'test',
            signal: payloadController.signal,
            timeoutMs: 5,
        }, {
            signal: optionController.signal,
            timeoutMs: 50,
        });
    });

    it('maps upstream abort identity to the CallAgent cancellation error', async () => {
        const reason = new Error('user cancelled');
        const controller = new AbortController();
        controller.abort(reason);
        const call = jest.fn(async () => {
            throw Object.assign(new Error('upstream abort'), { code: 'LLM_ABORTED' });
        });
        const adapter = createAdapter({ call });

        await adapter.call('test', { signal: controller.signal }).catch((error: unknown) => {
            expect(error).toBeInstanceOf(LLMCancelledError);
            expect(error).toEqual(expect.objectContaining({
                code: 'LLM_CANCELLED',
                reason,
            }));
        });
    });

    it('records a redacted terminal trace for a timed-out call', async () => {
        const ctx = {
            __currentModule: 'Execution',
            __turnLlmCalls: [],
        };
        const call = jest.fn(async () => {
            throw Object.assign(new Error('provider details'), {
                code: 'LLM_TIMEOUT',
                timeoutMs: 25,
            });
        });
        const adapter = createAdapter({ call }, ctx);

        await expect(adapter.call('secret prompt', {
            data: 'secret evidence',
            timeoutMs: 25,
            jsonSchema: { name: 'Assessment', schema: { type: 'object' } },
        })).rejects.toBeInstanceOf(LLMTimeoutError);

        expect(ctx.__turnLlmCalls).toEqual([
            expect.objectContaining({
                model: 'gpt-test',
                provider: 'openai',
                terminalReason: 'timeout',
                errorCode: 'LLM_TIMEOUT',
                module: 'Execution',
                outputContractName: 'Assessment',
                outputContractStatus: 'failed',
            }),
        ]);
        expect(JSON.stringify(ctx.__turnLlmCalls)).not.toContain('secret');
    });

    it('records exactly one completed public-call trace with aggregate usage', async () => {
        const ctx = {
            __currentModule: 'Execution',
            __turnLlmCalls: [],
        };
        const call = jest.fn(async () => [{
            role: 'assistant',
            content: 'done',
            metadata: {
                usage: {
                    tokens: { input: 3, output: 4 },
                    costs: { total: 0.01 },
                },
            },
        }]);
        const adapter = createAdapter({ call }, ctx);

        await adapter.call('test');

        expect(ctx.__turnLlmCalls).toHaveLength(1);
        expect(ctx.__turnLlmCalls[0]).toMatchObject({
            terminalReason: 'completed',
            inputTokens: 3,
            outputTokens: 4,
            cost: 0.01,
        });
    });

    it('starts the upstream stream deadline when stream() is called and maps terminal errors', async () => {
        let streamStarted = false;
        const stream = jest.fn((_message: string | Record<string, unknown>) => {
            streamStarted = true;
            return (async function* () {
                throw Object.assign(new Error('upstream timeout'), {
                    code: 'LLM_TIMEOUT',
                    timeoutMs: 10,
                });
            })();
        });
        const adapter = createAdapter({ stream });

        const output = adapter.stream('test', { timeoutMs: 10 });
        expect(streamStarted).toBe(true);
        const iterator = output[Symbol.asyncIterator]();
        await expect(iterator.next()).rejects.toBeInstanceOf(LLMTimeoutError);
    });

    it('records early stream consumption exit as cancellation once', async () => {
        const ctx = { __turnLlmCalls: [] };
        const stream = jest.fn(() => (async function* () {
            yield { role: 'assistant', content: 'partial', isComplete: false };
            await new Promise(() => undefined);
        })());
        const adapter = createAdapter({ stream }, ctx);
        const iterator = adapter.stream('test')[Symbol.asyncIterator]();

        await iterator.next();
        await iterator.return?.();

        expect(ctx.__turnLlmCalls).toHaveLength(1);
        expect(ctx.__turnLlmCalls[0]).toMatchObject({
            terminalReason: 'cancelled',
            errorCode: 'LLM_CANCELLED',
        });
    });
});
