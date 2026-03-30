import { describe, expect, it, jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox, type EnvironmentState } from '../src/loop/types.js';

const baseEnv = (): EnvironmentState => ({
    time: new Date().toISOString(),
    sessionId: 'session-loop-llm-contracts',
    turn: 1,
    budget: { maxTurns: 3, latencyMs: 1000 },
    pending: { inputs: {}, children: {}, tools: {}, groups: {} },
    inbox: normalizeObservationInbox(undefined),
    lastExec: undefined,
});

describe('loopRunner llm contracts defaults', () => {
    it('default answer_with_llm uses configured llm and emits llm.responded', async () => {
        const llmCall = jest.fn(async () => [{ role: 'assistant', content: 'Hi from llm' }]);
        let calls = 0;
        const ctx: any = {
            task: { id: 'llm-ok', input: 'hello' },
            llm: { call: llmCall, getHistoryMode: () => 'stateless' },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() },
            __llmConfigured: true,
        };
        const M: any = initialM(ctx);
        const env = baseEnv();

        const modules = {
            policy: () => {
                if (calls === 0) {
                    calls += 1;
                    return { kind: 'answer_with_llm', query: 'hello' };
                }
                return { kind: 'complete', result: 'done' };
            },
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2, collectTraces: true });
        expect(llmCall).toHaveBeenCalledWith('hello');
        expect(ctx.reply).toHaveBeenCalledWith('Hi from llm');
        expect(result.traces?.[0]?.transition?.kind).toBe('continue');
        expect(result.traces?.[0]?.execResult?.data).toBeDefined();
    });

    it('default answer_with_llm returns llm_not_configured error when llm is stubbed', async () => {
        let calls = 0;
        const ctx: any = {
            task: { id: 'llm-stub', input: 'hello' },
            llm: { call: jest.fn(async () => [{ role: 'assistant', content: 'stub' }]) },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() },
            __llmConfigured: false,
        };
        const M: any = initialM(ctx);
        const env = baseEnv();
        const modules = {
            policy: () => {
                if (calls === 0) {
                    calls += 1;
                    return { kind: 'answer_with_llm', query: 'echo me' };
                }
                return { kind: 'complete', result: 'done' };
            },
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2, collectTraces: true });
        expect(ctx.reply).toHaveBeenCalledWith('echo me');
        expect(result.traces?.[0]?.transition?.kind).toBe('continue');
    });
});
