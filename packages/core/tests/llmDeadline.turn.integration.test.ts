import { describe, expect, it, jest } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import { LLMCallerAdapter } from '../src/llm/LLMCallerAdapter.js';
import { LLMTimeoutError } from '../src/types/llmErrors.js';
import type { Intent } from '../src/types/intent.js';

describe('LLM deadline turn integration', () => {
    it('lets Execution handle a native timeout and the turn continue to a terminal result', async () => {
        let resolveProvider!: (value: unknown[]) => void;
        const providerOperation = new Promise<unknown[]>((resolve) => {
            resolveProvider = resolve;
        });
        const adapter = new LLMCallerAdapter({
            provider: 'openai',
            modelAliasOrName: 'gpt-4o-mini',
            apiKey: 'test',
            historyMode: 'stateless',
        });
        const caller = (adapter as unknown as { caller: Record<string, unknown> }).caller;
        caller.requestProcessor = {
            processRequest: jest.fn(async () => ['test']),
        };
        caller.chatController = {
            execute: jest.fn(() => providerOperation),
        };

        let policyCalls = 0;
        let learningCalls = 0;
        let transitionCalls = 0;
        let caught: unknown;
        const harness = createTestHarness({
            learning: (mentalState) => {
                learningCalls += 1;
                return mentalState;
            },
            policy: () => {
                policyCalls += 1;
                return policyCalls === 1
                    ? ({ kind: 'internal', intent: 'bounded_llm' } as Intent)
                    : ({ kind: 'complete', result: 'done' } as Intent);
            },
            execution: async (intent, ctx) => {
                if (intent.kind === 'internal') {
                    try {
                        await ctx.llm.call('test', { timeoutMs: 20 });
                    } catch (error) {
                        caught = error;
                    }
                }
                return {
                    action: intent,
                    result: { status: 'ok' as const, data: { timedOut: caught instanceof LLMTimeoutError } },
                };
            },
            transition: (_environment, exec) => {
                transitionCalls += 1;
                return exec.action.kind === 'complete'
                    ? { kind: 'complete' as const, result: 'done' }
                    : { kind: 'continue' as const };
            },
        });
        const stub = harness.llmStub();
        stub.call = adapter.call.bind(adapter);

        await harness.runTurn();
        expect(caught).toBeInstanceOf(LLMTimeoutError);
        harness.expectTurn((turn) => turn.expectTransition('continue'));

        await harness.runTurn();
        harness.expectComplete();
        expect(learningCalls).toBe(2);
        expect(transitionCalls).toBe(2);

        // The provider operation can settle after the turn without producing a
        // second transition or changing the terminal task result.
        resolveProvider([]);
        await Promise.resolve();
        await Promise.resolve();
        expect(transitionCalls).toBe(2);
        harness.expectComplete();
    });
});
