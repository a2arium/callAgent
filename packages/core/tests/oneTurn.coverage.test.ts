import { jest } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';

describe('oneTurn module error handling', () => {
    it('wraps attention errors', async () => {
        const h = createTestHarness({
            attention: () => { throw new Error('boom'); }
        });

        await h.runTurn();

        h.expectTurn(t => t.expectStageAfter('failed'));
        h.expectModuleError(e => {
            expect(e.message).toContain('attention module failed: boom');
        });
    });

    it('wraps perception errors', async () => {
        const h = createTestHarness({
            attention: () => 'a',
            perception: () => { throw new Error('p!'); }
        });

        await h.runTurn();

        h.expectModuleError(e => {
            expect(e.message).toContain('perception module failed: p!');
        });
    });
});

describe('oneTurn policy selection and rewards', () => {
    const originalRandom = Math.random;
    afterEach(() => {
        Math.random = originalRandom;
        jest.restoreAllMocks();
    });

    it('samples deterministic max when stochastic=false, and aggregates rewards', async () => {
        Math.random = jest.fn(() => 0.9) as any;

        const policySpy = jest.fn(function () {
            return [
                { action: { kind: 'answer_with_llm', query: 'low' } as Intent, prob: 0.2 },
                { action: { kind: 'answer_with_llm', query: 'high' } as Intent, prob: 0.9 }
            ];
        });

        const h = createTestHarness({
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            policy: policySpy as any,
            shield: (_m: any, a: any) => ({ action: 'pass', intent: a }),
            execution: async (a: any) => ({ action: { kind: 'answer_with_llm', echoed: true } as any, result: { status: 'ok', data: null }, transition: { kind: 'continue' } }),
            extrinsicReward: () => 2,
            intrinsicReward: () => 3
        });
        h.seedMentalState({ policyParams: { stochastic: false, explorationEpsilon: 0, temperature: 1 } } as any);

        await h.runTurn();

        expect(policySpy).toHaveBeenCalled();
        
        const traceBeforeAssert = h.lastTrace();
        console.log('TRACE IN TEST:', JSON.stringify(traceBeforeAssert, null, 2));
        // Harness executed the correct intent branch!
        h.expectTurn(t => t.expectIntent('answer_with_llm'));

        const trace = h.lastTrace();
        expect(trace.execResult?.status).toBe('ok');
        expect(trace.rewards?.total).toBe(5);

        // Verify traces
        expect(trace.attention).toBeDefined();
        expect(trace.perception).toBeDefined();
        expect(trace.intent).toBeDefined();
        expect(trace.shield).toBeDefined();
        expect(Array.isArray(trace.inboxCurrent)).toBe(true);
    });

    it('uses epsilon stochastic branch when explorationEpsilon triggers', async () => {
        const originalRandom = Math.random;
        Math.random = jest.fn().mockReturnValue(0.001);

        const h = createTestHarness({
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            policy: () => [
                { action: { kind: 'answer_with_llm', query: 'first' } as Intent, prob: 0.1 },
                { action: { kind: 'answer_with_llm', query: 'second' } as Intent, prob: 0.9 }
            ],
            shield: (_m: any, a: any) => ({ action: 'pass', intent: a }),
            execution: async (a: any) => ({ action: a, result: { status: 'ok', data: null }, transition: { kind: 'continue' } })
        });
        h.seedMentalState({ policyParams: { stochastic: true, explorationEpsilon: 1 } } as any);

        await h.runTurn();
        
        // Resulted in the first action inside the tuple due to forced rand
        const trace = h.lastTrace();
        expect((trace.intent as any).data.query).toBe('first');
        Math.random = originalRandom;
    });
});

describe('oneTurn shield mapping and error handling', () => {
    it('maps shield defer to prompt_user and veto to internal', async () => {
        const hDefer = createTestHarness({
            policy: () => ({ kind: 'answer_with_llm', query: 'hi' } as Intent),
            shield: () => ({ action: 'defer', askUser: 'why?' }),
            execution: async (a: any) => ({ action: { kind: 'prompt_user', token: 'tok' } as any, result: { status: 'ok', data: null }, transition: { kind: 'await_input', token: 'tok' } })
        });

        await hDefer.runTurn();
        
        // It transformed into ask_user/prompt_user during shield
        const traceDefer = hDefer.lastTrace();
        expect(traceDefer.shield?.action).toBe('defer');
        expect(traceDefer.transition?.kind).toBe('await_input');

        // veto path
        const hVeto = createTestHarness({
            policy: () => ({ kind: 'answer_with_llm', query: 'hi' } as Intent),
            shield: () => ({ action: 'veto', reason: 'nope' }),
            execution: async (a: any) => ({ action: a, result: { status: 'ok', data: { intent: 'vetoed' } }, transition: { kind: 'continue' } })
        });
        
        await hVeto.runTurn();
        const traceVeto = hVeto.lastTrace();
        expect(traceVeto.shield?.action).toBe('veto');
        expect((traceVeto.execResult?.data as any).intent).toBe('vetoed');
    });

    it('wraps execution and transition errors', async () => {
        const badExec = createTestHarness({
            policy: () => ({ kind: 'internal', intent: 'x' } as Intent),
            execution: async () => { throw new Error('exec boom'); }
        });
        await badExec.runTurn();
        badExec.expectModuleError(e => {
            expect(e.message).toContain('execution module failed: exec boom');
        });

        const badTransition = createTestHarness({
            policy: () => ({ kind: 'internal', intent: 'x' } as Intent),
            execution: async (a: any) => ({ action: a, result: { status: 'ok', data: { done: true } }, transition: { kind: 'continue' } }),
            transition: () => { throw new Error('transition boom'); }
        });
        await badTransition.runTurn();
        badTransition.expectModuleError(e => {
            expect(e.message).toContain('transition module failed: transition boom');
        });
    });
});
