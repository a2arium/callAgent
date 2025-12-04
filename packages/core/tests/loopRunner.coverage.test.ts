import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox, type EnvironmentState } from '../src/loop/types.js';

const baseEnv = (overrides: Partial<EnvironmentState<any>> = {}): EnvironmentState<any> => ({
    time: new Date().toISOString(),
    sessionId: 'session',
    turn: 1,
    budget: { maxTurns: 10, latencyMs: 1_000 },
    pending: { inputs: {}, children: {}, tools: {}, groups: {} },
    inbox: normalizeObservationInbox(undefined),
    lastExec: undefined,
    ...overrides
});

afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
});

describe('runLoop memory wiring and defaults', () => {
    it('applies memory patches, flushes semantic registry, and keeps inbox normalized', async () => {
        const semanticRegistry = {
            read: jest.fn((q: any) => q?.id === 'reg'
                ? [{ key: 'reg', value: { fromRegistry: true }, embedding: [0.1], source: 'db' }]
                : []),
            set: jest.fn(),
            delete: jest.fn()
        };

        const ctx: any = { task: { id: 'memory-task', input: 'hello' }, memory: { semantic: semanticRegistry } };
        const M: any = initialM(ctx);
        M.memory.longTerm.semantic.concepts = [{ id: 'old', data: { existing: true } } as any];
        M.memory.longTerm.episodic = [{ t: 0, obs: 'past' } as any];
        M.rewardParams.intrinsic.novelty = 1;
        M.policyParams.reactPlanner = { enabled: true, patterns: [{ regex: '(hello)', tool: 'echo', argKey: 'msg' }] };
        M.memory.sensory.lastObservation = 'hello world';

        const env = baseEnv({ inbox: undefined as any });
        const readerSnapshot: Record<string, any> = {};
        const writerSnapshot: Record<string, any> = {};
        let turnsRan = 0;

        const modules = {
            attention: () => ({}),
            perception: (envArg: any) => {
                readerSnapshot.perceptionInbox = [...envArg.inbox.current];
                return { inbox: envArg.inbox.current, time: envArg.time, pending: envArg.pending } as any;
            },
            learning: async (prev: any, _prevAction: any, _obs: any, mem: any, writer: any) => {
                turnsRan += 1;
                readerSnapshot.registry = await mem.semantic.read({ id: 'reg' });
                readerSnapshot.fallback = await mem.semantic.read({ id: 'old' });
                readerSnapshot.byId = await mem.semantic.get('old');
                readerSnapshot.episodic = await mem.episodic.range({ from: 0, to: 10, limit: 1 });
                readerSnapshot.policy = await mem.policy.getParams();
                readerSnapshot.reward = await mem.reward.getParams();

                writer.semantic.add({ id: 'new', data: { foo: 'bar' } } as any);
                writer.semantic.delete('old');
                writer.episodic.append({ t: 1, obs: 'new' } as any);
                writer.procedural.set([{ id: 'p2' } as any]);
                writer.world.set({ explicit: 'world-state' } as any);
                writer.goals.set({ nodes: { root: { id: 'root' } as any }, roots: ['root'] });
                writer.goals.update('root', { status: 'done' } as any);
                writer.policy.setParams({ theta: 7 } as any);
                writer.reward.setParams({ intrinsic: { novelty: 1 } } as any);

                return writer.__applyToMental(prev);
            },
            policy: () => ({ kind: 'language', content: 'hi' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any),
            execution: async (intent: any) => ({ action: intent, result: { status: 'ok', data: intent } }),
            transition: () => {
                if (turnsRan === 1) return { kind: 'continue', observations: [{ kind: 'obs', payload: { value: 1 } }] } as any;
                return { kind: 'await_input', token: 'stop' } as any;
            }
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });

        expect(readerSnapshot.registry?.[0]).toMatchObject({ id: 'reg', data: { fromRegistry: true }, source: 'db' });
        expect(semanticRegistry.read).toHaveBeenCalledWith({ id: 'old' });
        expect(readerSnapshot.perceptionInbox[0]).toMatchObject({ kind: 'obs' });
        expect(semanticRegistry.set).toHaveBeenCalledWith('new', { foo: 'bar' }, { tags: undefined, entities: undefined });
        expect(semanticRegistry.delete).toHaveBeenCalledWith('old');

        expect(result.M.memory.longTerm.semantic.concepts).toEqual([{ id: 'new', data: { foo: 'bar' } }]);
        expect(result.M.memory.longTerm.episodic.length).toBeGreaterThanOrEqual(3);
        expect(result.M.memory.longTerm.procedural.skills).toEqual([{ id: 'p2' }]);
        expect(result.M.goalState?.hierarchy?.nodes?.root?.status).toBe('done');
        expect(result.metrics?.timings?.length).toBeGreaterThan(0);
        expect(result.metrics?.rewards?.length).toBeGreaterThan(0);

        expect(env.inbox.current[0]).toMatchObject({ kind: 'obs' });
        expect(env.inbox.all.length).toBeGreaterThan(0);
    });
});

describe('runLoop memory fallbacks and goal mutations', () => {
    it('uses in-memory fallback readers and applies goal add/remove/clear patches', async () => {
        const ctx: any = { task: { id: 'fallback-task', input: {} } };
        const M: any = initialM(ctx);
        M.memory.longTerm.semantic.concepts = [
            { id: 'c1', data: { v: 1 } } as any,
            { id: 'c2', data: { v: 2 } } as any
        ];
        M.goalState = {
            hierarchy: {
                nodes: { a: { id: 'a', status: 'new' } as any },
                roots: ['a']
            }
        };

        const env = baseEnv({ inbox: [{ kind: 'seed', payload: {} } as any] as any });
        const goalSnapshots: any[] = [];
        const semanticSnapshots: any[] = [];

        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any, _prevAction: any, _obs: any, mem: any, writer: any) => {
                semanticSnapshots.push(mem.semantic.read());
                semanticSnapshots.push(mem.semantic.get('c2'));
                goalSnapshots.push(mem.goals.get());

                writer.goals.add({ id: 'b', status: 'added' } as any);
                writer.goals.remove('b');
                writer.goals.clear(() => false);
                writer.goals.set({ nodes: { x: { id: 'x', status: 'done' } as any }, roots: ['x'] });
                writer.policy.setParams({ theta: 2 } as any);

                return writer.__applyToMental(prev);
            },
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any),
            transition: () => ({ kind: 'await_input', token: 'halt' } as any),
            execution: (intent: any) => ({ action: intent, result: { status: 'ok' } })
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 1 });

        const firstSem = await semanticSnapshots[0];
        const secondSem = await semanticSnapshots[1];
        expect(Array.isArray(firstSem)).toBe(true);
        expect(secondSem?.id).toBe('c2');
        const firstGoal = await goalSnapshots[0];
        expect(firstGoal?.nodes?.a).toBeTruthy();
        expect(result.M.goalState?.hierarchy?.roots).toEqual(['x']);
        expect(result.M.policyParams?.theta).toBe(2);
    });
});

describe('runLoop default execution and transitions', () => {
    it('routes every execution branch and maps transitions', async () => {
        const ctx: any = {
            task: { id: 'execution-task', input: {} },
            reply: jest.fn(),
            requestInput: jest.fn().mockResolvedValue({ token: 'input-token' }),
            sendTaskToAgent: jest.fn()
                .mockResolvedValueOnce({ token: 'child-token' })
                .mockResolvedValueOnce({ note: 'done' }),
            requestTool: jest.fn().mockResolvedValue({ token: 'tool-token' }),
            tools: { invoke: jest.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('tool error')) }
        };
        const M: any = initialM(ctx);
        const env = baseEnv({ pending: { inputs: {}, children: { 'pending-child': {} }, tools: {}, groups: {} } });

        const transitionResults: any[] = [];
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: [], time: env.time, pending: env.pending } as any),
            learning: async (prev: any, _prevAction: any, _obs: any, mem: any) => {
                const askRes = await ctx.defaults.execution({ kind: 'ask_user', prompt: 'Need input', schema: {} } as any, ctx, mem);
                const childRes = await ctx.defaults.execution({ kind: 'subagent', target: 'child', input: {} } as any, ctx, mem);
                const childNoToken = await ctx.defaults.execution({ kind: 'subagent', target: 'child', input: {} } as any, ctx, mem);
                const toolAwait = await ctx.defaults.execution({ kind: 'tool', name: 'needs-callback', args: {}, awaitCallback: true } as any, ctx, mem);
                const toolImmediate = await ctx.defaults.execution({ kind: 'tool', name: 'immediate', args: {} } as any, ctx, mem);
                const toolError = await ctx.defaults.execution({ kind: 'tool', name: 'fails', args: {} } as any, ctx, mem);
                const languageRes = await ctx.defaults.execution({ kind: 'language', content: 'hello' } as any, ctx, mem);
                const internalRes = await ctx.defaults.execution({ kind: 'unknown', intent: 'noop' } as any, ctx, mem);

                transitionResults.push(
                    ctx.defaults.transition(env, askRes as any, M, mem),
                    ctx.defaults.transition(env, childRes as any, M, mem),
                    ctx.defaults.transition(env, languageRes as any, M, mem),
                    ctx.defaults.transition(env, { ...internalRes, action: { kind: 'internal' } } as any, M, mem),
                    ctx.defaults.transition(env, toolAwait as any, M, mem),
                    ctx.defaults.transition(env, toolImmediate as any, M, mem)
                );

                return prev;
            },
            policy: () => ({ kind: 'ask_user', prompt: 'Need input' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any)
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 1 });

        expect(ctx.requestInput).toHaveBeenCalledWith('Need input', expect.any(Object));
        expect(ctx.sendTaskToAgent).toHaveBeenCalledTimes(2);
        expect(ctx.requestTool).toHaveBeenCalledWith('needs-callback', {}, expect.any(Object));
        expect(ctx.tools.invoke).toHaveBeenCalledTimes(2);
        expect(ctx.reply).toHaveBeenCalledWith('hello');
        expect(transitionResults.map(t => t.kind)).toEqual(['await_input', 'await_child', 'await_child', 'await_child', 'await_tool', 'await_child']);
        expect(result.outcome.kind).toBe('await_input');
    });
});

describe('runLoop await_child fast-paths', () => {
    it('continues loop when child completion is already in the inbox', async () => {
        const ctx: any = { task: { id: 'child-sync', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const childObs = { kind: 'child.completed', payload: { token: 'child-token', data: 'ok' } };
        const env = baseEnv({
            inbox: normalizeObservationInbox({ current: [], all: [childObs] }),
            pending: { inputs: {}, children: { 'child-token': {} }, tools: {}, groups: {} }
        });

        let call = 0;
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any) => { call += 1; return prev; },
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any),
            execution: () => ({ action: { kind: 'internal' }, result: { status: 'ok' } }),
            transition: () => (call === 1
                ? { kind: 'await_child', token: 'child-token' } as any
                : { kind: 'await_tool', token: 'tool-final' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2 });

        expect(env.pending.children['child-token']).toBeUndefined();
        expect(result.outcome.kind).toBe('await_tool');
        expect(env.inbox.current[0]).toMatchObject(childObs);
    });

    it('reloads inbox from session manager when child completion is persisted externally', async () => {
        const childObs = { kind: 'child.completed', payload: { token: 'reload-child', value: 1 } };
        const sessionManager = { load: jest.fn().mockResolvedValue({ snapshot: { inbox: { all: [childObs], current: [] } } }) };
        const ctx: any = { task: { id: 'child-reload-task', input: {} }, _sessionManager: sessionManager, tenantId: 'tenant-1', reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({
            inbox: normalizeObservationInbox({ current: [], all: [] }),
            pending: { inputs: {}, children: { 'reload-child': {} }, tools: {}, groups: {} }
        });

        let call = 0;
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any) => { call += 1; return prev; },
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any),
            execution: () => ({ action: { kind: 'internal' }, result: { status: 'ok' } }),
            transition: () => (call === 1
                ? { kind: 'await_child', token: 'reload-child' } as any
                : { kind: 'await_input', token: 'end' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2 });

        expect(sessionManager.load).toHaveBeenCalledWith('tenant-1', 'child-reload-task');
        expect(env.pending.children['reload-child']).toBeUndefined();
        expect(env.inbox.current[0]).toMatchObject(childObs);
        expect(result.outcome.kind).toBe('await_input');
    });
});

describe('runLoop budgets, errors, and observation normalization', () => {
    it('fails when env.turn already exceeds global budget', async () => {
        const ctx: any = { task: { id: 'budget-task', input: {} } };
        const M: any = initialM(ctx);
        const env = baseEnv({ turn: 5, budget: { maxTurns: 4, latencyMs: 0 } });

        const result = await runLoop(ctx, M, env, {} as any, { maxTurns: 10 });

        expect(result.outcome).toEqual({ kind: 'fail', reason: 'budget_turns_exceeded' });
    });

    it('fails fast when latency budget is exceeded', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1000;
        nowSpy.mockImplementation(() => {
            now += 10;
            return now;
        });

        const ctx: any = { task: { id: 'latency-task', input: {} } };
        const M: any = initialM(ctx);
        const env = baseEnv();

        const result = await runLoop(ctx, M, env, {} as any, { maxTurns: 5, latencyMs: 1 });

        expect(result.outcome).toEqual({ kind: 'fail', reason: 'budget_latency_exceeded' });
    });

    it('normalizes continue outcomes, preserves inbox when no observations, and captures turn errors', async () => {
        const ctx: any = { task: { id: 'error-task', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({ inbox: normalizeObservationInbox([{ kind: 'existing', payload: {} } as any]) });

        let call = 0;
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any),
            execution: () => {
                if (call === 0) {
                    call += 1;
                    return { action: { kind: 'internal' }, result: { status: 'ok' } };
                }
                throw new Error('boom');
            },
            transition: () => (call === 1
                ? { kind: 'continue', observations: undefined } as any
                : { kind: 'continue', observations: [] } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });

        expect(env.inbox.current[0]).toMatchObject({ kind: 'existing' });
        expect(result.outcome.kind).toBe('fail');
        expect(String(result.outcome.reason)).toContain('turn_1_error');
    });
});
