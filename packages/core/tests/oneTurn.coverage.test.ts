import { jest } from '@jest/globals';
import { oneTurn, type Modules, type ProposedAction } from '../src/loop/oneTurn.js';

const baseEnv = (): any => ({
    time: new Date().toISOString(),
    sessionId: 'sess',
    turn: 1,
    budget: { maxTurns: 10, latencyMs: 0 },
    inbox: { current: [], all: [] },
    pending: { inputs: {}, children: {}, tools: {}, groups: {} }
});

const baseMemReader = () => ({
    semantic: { read: async () => [], get: async () => null },
    episodic: { range: async () => [] },
    procedural: { list: async () => [] },
    world: { get: async () => null },
    goals: { get: async () => ({ nodes: {}, roots: [] }) },
    policy: { getParams: async () => ({}) },
    reward: { getParams: async () => ({}) }
});

const baseWriter = () => {
    const episodic: any[] = [];
    return {
        semantic: { add: jest.fn(), delete: jest.fn() },
        episodic: { append: (e: any) => episodic.push(e) },
        procedural: { set: jest.fn() },
        world: { set: jest.fn() },
        goals: { set: jest.fn(), add: jest.fn(), update: jest.fn(), remove: jest.fn(), clear: jest.fn() },
        policy: { setParams: jest.fn() },
        reward: { setParams: jest.fn() },
        __applyToMental: (m: any) => ({ ...m, applied: true, episodicPatched: episodic.length }),
    };
};

const baseM = (): any => ({
    memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
    policyParams: { stochastic: true },
    rewardParams: {},
    goalState: { hierarchy: { nodes: {}, roots: [] } }
});

describe('oneTurn module error handling', () => {
    it('wraps attention errors', async () => {
        const modules: Partial<Modules> = {
            attention: () => { throw new Error('boom'); }
        };
        const env = baseEnv();
        const m = baseM();
        const mem = baseMemReader();
        const writer = baseWriter();

        await expect(oneTurn({ task: { id: 't', input: {} } } as any, env, m, modules as any, mem as any, writer as any))
            .rejects.toThrow('attention module failed: boom');
    });

    it('wraps perception errors', async () => {
        const modules: Partial<Modules> = {
            attention: () => 'a',
            perception: () => { throw new Error('p!'); }
        };
        const env = baseEnv();
        const m = baseM();
        const mem = baseMemReader();
        const writer = baseWriter();

        await expect(oneTurn({ task: { id: 't', input: {} } } as any, env, m, modules as any, mem as any, writer as any))
            .rejects.toThrow('perception module failed: p!');
    });
});

describe('oneTurn policy selection and rewards', () => {
    const originalRandom = Math.random;
    afterEach(() => {
        Math.random = originalRandom;
        jest.restoreAllMocks();
    });

    it('applies writer patch before policy, samples deterministic max when stochastic=false, and aggregates rewards', async () => {
        Math.random = jest.fn(() => 0.9) as any;

        const env = baseEnv();
        const mPrev = baseM();
        mPrev.policyParams = { stochastic: false, explorationEpsilon: 0, temperature: 1 };

        const mem = baseMemReader();
        const writer = baseWriter();
        const policySpy = jest.fn(function policyFn(m: any, prev: any, obs: any, reader: any) {
            return [
                { action: { kind: 'language', content: 'low' }, prob: 0.2 },
                { action: { kind: 'language', content: 'high' }, prob: 0.9 }
            ];
        });

        const modules: Modules<any, any, any, any, any, any> = {
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            learning: (prev: any) => ({ ...prev, memory: { ...prev.memory, longTerm: { ...prev.memory.longTerm, episodic: [{ t: 1 }] } } }),
            policy: policySpy as any,
            shield: (_m: any, a: ProposedAction) => ({ action: 'pass', intent: a }),
            execution: async (a: ProposedAction) => ({ action: { kind: 'language', echoed: true } as any, result: { status: 'ok', data: a } }),
            transition: () => ({ kind: 'continue', observations: [] }),
            extrinsicReward: () => 2,
            intrinsicReward: () => 3
        };

        const result = await oneTurn({ task: { id: 't', input: {} } } as any, env, mPrev, modules, mem as any, writer as any);

        expect(policySpy).toHaveBeenCalled();
        expect(result.exec.result.data).toMatchObject({ content: 'high' });
        expect(result.m.applied).toBe(true);
        expect(result.reward).toBe(5);
        expect((result.m.memory.longTerm.episodic as any[])[0].rew).toBe(5);
    });

    it('uses epsilon stochastic branch when explorationEpsilon triggers', async () => {
        Math.random = jest.fn()
            // epsilon check
            .mockReturnValueOnce(0)
            // random index selection for epsilon
            .mockReturnValueOnce(0) as any;

        const env = baseEnv();
        const mPrev = baseM();
        mPrev.policyParams = { stochastic: true, explorationEpsilon: 1 };
        const mem = baseMemReader();
        const writer = baseWriter();

        const modules: Modules<any, any, any, any, any, any> = {
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            learning: (prev: any) => prev,
            policy: () => [
                { action: { kind: 'language', content: 'first' }, prob: 0.1 },
                { action: { kind: 'language', content: 'second' }, prob: 0.9 }
            ],
            shield: (_m: any, a: ProposedAction) => ({ action: 'pass', intent: a }),
            execution: async (a: ProposedAction) => ({ action: { kind: 'language', echoed: true } as any, result: { status: 'ok', data: a } }),
            transition: () => ({ kind: 'continue', observations: [] })
        };

        const result = await oneTurn({ task: { id: 't', input: {} } } as any, env, mPrev, modules, mem as any, writer as any);
        expect(result.exec.result.data).toMatchObject({ content: 'first' });
    });
});

describe('oneTurn shield mapping and error handling', () => {
    it('maps shield defer to ask_user and veto to internal', async () => {
        const env = baseEnv();
        const mPrev = baseM();
        const mem = baseMemReader();
        const writer = baseWriter();

        const modules: Modules<any, any, any, any, any, any> = {
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'language', content: 'hi' }),
            shield: (_m: any, _a: ProposedAction) => ({ action: 'defer', askUser: 'why?' }),
            execution: async (a: ProposedAction) => ({ action: { kind: 'ask_user', token: 'tok' } as any, result: { status: 'ok', data: a } }),
            transition: () => ({ kind: 'await_input', token: 'tok' })
        };

        const resultDefer = await oneTurn({ task: { id: 't', input: {} } } as any, env, mPrev, modules, mem as any, writer as any);
        expect(resultDefer.exec.action).toMatchObject({ kind: 'ask_user' });

        // veto path
        const vetoModules = { ...modules, shield: () => ({ action: 'veto', reason: 'nope' }) } as any;
        const resultVeto = await oneTurn({ task: { id: 't2', input: {} } } as any, env, mPrev, vetoModules, mem as any, writer as any);
        expect(resultVeto.exec.result.data).toMatchObject({ intent: 'vetoed' });
    });

    it('wraps execution and transition errors', async () => {
        const env = baseEnv();
        const mPrev = baseM();
        const mem = baseMemReader();
        const writer = baseWriter();

        const badExecModules: Modules<any, any, any, any, any, any> = {
            attention: () => 'alpha',
            perception: () => ({ obs: true }),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'internal', intent: 'x' }),
            shield: (_m: any, a: ProposedAction) => ({ action: 'pass', intent: a }),
            execution: async () => { throw new Error('exec boom'); },
            transition: () => ({ kind: 'continue', observations: [] })
        };
        await expect(oneTurn({ task: { id: 't', input: {} } } as any, env, mPrev, badExecModules, mem as any, writer as any))
            .rejects.toThrow('execution module failed: exec boom');

        const badTransitionModules = { ...badExecModules, execution: async (a: ProposedAction) => ({ action: { kind: 'internal', done: true } as any, result: { status: 'ok', data: a } }), transition: () => { throw new Error('transition boom'); } } as any;
        await expect(oneTurn({ task: { id: 't', input: {} } } as any, env, mPrev, badTransitionModules, mem as any, writer as any))
            .rejects.toThrow('transition module failed: transition boom');
    });
});
