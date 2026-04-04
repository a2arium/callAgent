import { createTestContext } from '../src/testing/TestContext.js';
import { createDeterministicLLMStub, createDeterministicToolStub } from '../src/testing/DeterministicStubs.js';
import { HarnessConfigSchema, type HarnessState } from '../src/testing/harnessTypes.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { MentalState } from '../src/loop/types.js';

describe('TestContext', () => {
    let state: HarnessState;
    let llmStub: ReturnType<typeof createDeterministicLLMStub>;
    let toolStub: ReturnType<typeof createDeterministicToolStub>;

    beforeEach(() => {
        state = {
            m: {} as any,
            env: {} as any,
            inboxAll: [],
            traces: [],
            replies: [],
            errors: [],
            turnCount: 0,
            childDispatches: []
        };
        llmStub = createDeterministicLLMStub();
        toolStub = createDeterministicToolStub();
    });

    it('creates a TaskContext with correct initial shape', () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        expect(ctx.tenantId).toBe('test-tenant');
        expect(ctx.agentId).toBe('test-agent');
        expect(ctx.task.id).toBe('test-task-1');
        expect(ctx.task.input).toEqual({});
        expect((ctx as InternalTaskContext).controlVars).toEqual({});
    });

    it('propagates MentalState writes via ctx.M setter', () => {
        state.m = {
            memory: { sensory: { x: 1 }, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0 },
            rewardParams: {
                extrinsicWeights: [1],
                intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 },
                discountGamma: 0.99,
            },
            policyParams: { theta: null, stochastic: false },
        } as MentalState;
        const ctx = createTestContext(state, llmStub, toolStub);
        const next: MentalState = {
            ...state.m,
            memory: { ...state.m.memory, sensory: { y: 2 } },
        };
        ctx.M = next;
        expect(state.m).toBe(next);
        expect((ctx.M.memory.sensory as { y?: number }).y).toBe(2);
    });

    it('captures replies correctly', async () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        await ctx.reply('hello');
        await ctx.reply({ type: 'text', text: 'world' });

        expect(state.replies).toHaveLength(2);
        expect(state.replies).toEqual(['hello', { type: 'text', text: 'world' }]);
    });

    it('captures errors correctly', async () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        await ctx.fail(new Error('test failure'));
        await ctx.fail('string failure');

        expect(state.errors).toHaveLength(2);
        expect(state.errors[0]?.message).toBe('test failure');
        expect(state.errors[1]?.message).toBe('string failure');
    });

    it('throws structured invariant errors', () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        expect(() => {
            ctx.throw('TOKEN_MISMATCH', 'Test Error', { type: 'token_validation', category: 'input', reason: 'missing' }, { turnId: 'turn-1' });
        }).toThrowError('Test Error');

        try {
            ctx.throw('TOKEN_MISMATCH', 'Test Error', { type: 'token_validation', category: 'input', reason: 'missing' }, { turnId: 'turn-1' });
        } catch (err: any) {
            expect(err.name).toBe('InvariantError');
            expect(err.code).toBe('TOKEN_MISMATCH');
            expect(err.detail.type).toBe('token_validation');
        }
    });

    it('wires the llm stub properly', () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        expect(ctx.llm.call).toBe(llmStub.call);
    });

    it('wires the tool stub properly', async () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        toolStub.register('myTool', { ok: true });
        
        const result = await ctx.tools.invoke('myTool', { a: 1 });
        expect(result).toEqual({ ok: true });
        
        const calls = toolStub.getCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.tool).toBe('myTool');
        expect(calls[0]?.args).toEqual({ a: 1 });
    });

    it('captures simple child task dispatches', async () => {
        const ctx = createTestContext(state, llmStub, toolStub);
        
        const handle = await ctx.sendTaskToAgent('sub-agent', { myQuery: 'hello' }, { awaitCompletion: false });
        expect(state.childDispatches).toHaveLength(1);
        expect(state.childDispatches[0]).toEqual({ agent: 'sub-agent', input: { myQuery: 'hello' } });
        
        // Generates valid token
        expect(handle.token).toMatch(/^child-\d+$/);
    });
});
