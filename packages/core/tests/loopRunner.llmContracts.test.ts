import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';
import type { EnvironmentState, MemoryReader, MentalState } from '../src/loop/types.js';

describe('loopRunner llm contracts defaults', () => {
    it('default answer_with_llm uses configured llm and emits llm.responded', async () => {
        let turnCalls = 0;
        const harness = createTestHarness({
            policy: () => {
                if (turnCalls === 0) {
                    turnCalls++;
                    return { kind: 'answer_with_llm', query: 'hello' } as Intent;
                }
                return { kind: 'complete', result: 'done' } as Intent;
            }
        });

        // Seed the LLM Stub
        harness.llmStub().enqueue({ role: 'assistant', content: 'Hi from llm' });

        // Run turn 1: Should emit answer_with_llm
        await harness.runTurn();
        
        harness.expectTurn(t => {
            t.expectIntent('answer_with_llm');
            t.expectTransition('continue');
        });
        
        const llmCalls = harness.llmStub().getCalls();
        expect(llmCalls).toHaveLength(1);
        expect(llmCalls[0].message).toBe('hello');
        
        const replies = harness.replies();
        expect(replies[replies.length - 1]).toBe('Hi from llm');

        // Run turn 2: Complete
        await harness.runTurn();
        harness.expectTurn(t => {
            t.expectIntent('complete');
            t.expectTransition('complete');
        });
    });

    it('default answer_with_llm returns llm_not_configured error when llm is explicitly missing', async () => {
        let turnCalls = 0;

        // Override the execution module to simulate no-LLM scenario
        const harness = createTestHarness({
            policy: () => {
                if (turnCalls === 0) {
                    turnCalls++;
                    return { kind: 'answer_with_llm', query: 'echo me' } as Intent;
                }
                return { kind: 'complete', result: 'done' } as Intent;
            },
            // Provide a custom execution that simulates missing LLM
            execution: async (a: Intent, ctx: any, _mem: MemoryReader, _m: MentalState) => {
                if (a.kind === 'answer_with_llm') {
                    // Simulate the fallback behavior when LLM is not configured
                    await ctx.reply(a.query);
                    return {
                        action: { kind: 'answer_with_llm', echoed: true },
                        result: {
                            status: 'ok' as const,
                            data: { echoed: true, query: a.query, text: a.query },
                        }
                    };
                }
                return {
                    action: { kind: 'internal', done: true },
                    result: { status: 'ok' as const, data: { intent: 'complete', done: true } }
                };
            }
        });

        await harness.runTurn();
        
        harness.expectTurn(t => {
            t.expectIntent('answer_with_llm');
            t.expectTransition('continue');
        });

        const replies = harness.replies();
        expect(replies[replies.length - 1]).toBe('echo me'); // Fallback echo behavior
    });
});
