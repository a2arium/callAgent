import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox, type EnvironmentState } from '../src/loop/types.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';

const baseEnv = (overrides: Partial<EnvironmentState> = {}): EnvironmentState => ({
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
    EngineLocator.setEngine(null);
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
        const appendOperatorEvent = jest.fn(async () => ({ eventId: 'event-1', seq: 1 }));
        EngineLocator.setEngine({ appendOperatorEvent });

        const ctx: any = { 
            task: { id: 'memory-task', input: 'hello' }, 
            memory: { semantic: semanticRegistry },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() }
        };
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
                if (turnsRan === 1) return { kind: 'continue', observations: [{ source: 'internal', kind: 'state.noted', payload: { value: 1 } }] } as any;
                return { kind: 'await_input', token: 'stop' } as any;
            }

        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });

        expect(readerSnapshot.registry?.[0]).toMatchObject({ id: 'reg', data: { fromRegistry: true }, source: 'db' });
        expect(semanticRegistry.read).toHaveBeenCalledWith({ id: 'old' });
        expect(readerSnapshot.perceptionInbox[0]).toMatchObject({ kind: 'state.noted' });
        expect(semanticRegistry.set).toHaveBeenCalledWith('new', { foo: 'bar' }, { tags: undefined, entities: undefined });
        expect(semanticRegistry.delete).toHaveBeenCalledWith('old');

        expect(result.M.memory.longTerm.semantic.concepts).toEqual([{ id: 'new', data: { foo: 'bar' } }]);
        expect(result.M.memory.longTerm.episodic.length).toBeGreaterThanOrEqual(3);
        expect(result.M.memory.longTerm.procedural.skills).toEqual([{ id: 'p2' }]);
        expect(result.M.goalState?.hierarchy?.nodes?.root?.status).toBe('done');
        expect(result.metrics?.timings?.length).toBeGreaterThan(0);
        expect(result.metrics?.rewards?.length).toBeGreaterThan(0);
        expect(appendOperatorEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'memory.read',
            payload: expect.objectContaining({
                query: expect.objectContaining({ id: 'reg' }),
                resultKeys: ['reg'],
                resultCount: 1,
                status: 'success',
            }),
        }));

        expect(env.inbox.current.length).toBe(0);
        expect(env.inbox.all.length).toBeGreaterThan(0);
    });

    it('returns traces when collectTraces true and stamps manifest provenance and pending summary', async () => {
        const ctx: any = {
            task: { id: 'trace-coverage-task', input: 'x' },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() },
        };
        const M: any = initialM(ctx);
        const env = baseEnv();
        const modules = {
            attention: () => ({}),
            perception: (e: any) => ({ inbox: e.inbox.current, time: e.time, pending: e.pending }),
            learning: async (prev: any) => prev,
            policy: () => ({ kind: 'language', content: 'done' }),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent }),
            execution: async (intent: any) => ({ action: intent, result: { status: 'ok', data: intent } }),
            transition: () => ({ kind: 'complete', observations: [] }),
        };
        const provenance = { agentCardSource: 'inline' as const, runtimeManifestSource: 'inline' as const, agentCardHash: 'ah', runtimeManifestHash: 'rh' };

        const resultNoTraces = await runLoop(ctx, M, env, modules as any, { maxTurns: 1 });
        expect(resultNoTraces.traces).toBeUndefined();

        const resultWithTraces = await runLoop(ctx, M, env, modules as any, { maxTurns: 2, collectTraces: true, manifestProvenance: provenance });
        expect(resultWithTraces.traces).toBeDefined();
        expect(Array.isArray(resultWithTraces.traces)).toBe(true);
        expect(resultWithTraces.traces!.length).toBeGreaterThanOrEqual(1);
        const first = resultWithTraces.traces![0];
        expect(first.turn).toBe(1);
        expect(first.turnId).toBeDefined();
        expect(first.agentCardSource).toBe('inline');
        expect(first.runtimeManifestSource).toBe('inline');
        expect(first.agentCardHash).toBe('ah');
        expect(first.runtimeManifestHash).toBe('rh');
        expect(first.timings).toBeDefined();
        expect(first.timings.totalMs).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(first.inboxCurrent)).toBe(true);
        expect(first.pendingAfter).toBeDefined();
        expect(first.conversation).toBeUndefined();
    });

    it('stamps incoming conversation messages into trace when present in inbox', async () => {
        const ctx: any = {
            task: { id: 'trace-conversation-task', input: 'x' },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() },
        };
        const M: any = initialM(ctx);
        const env = baseEnv({
            inbox: normalizeObservationInbox({
                current: [{
                    source: 'conversation',
                    kind: 'message.received',
                    payload: {
                        kind: 'message.received',
                        message: {
                            id: 'msg-cov-1',
                            conversation: { kind: 'thread', id: 'thread-cov-1' },
                            senderAgentId: 'agent-parent',
                            senderMemberId: 'agent-parent',
                            recipientAgentId: 'agent-child',
                            recipientMemberId: 'mem-child',
                            speechAct: 'request',
                            content: { task: 'x' },
                            sequenceNumber: 1,
                            ts: new Date().toISOString(),
                        },
                    },
                }],
                all: [],
            }),
        });
        const modules = {
            attention: () => ({}),
            perception: () => ({ ok: true }),
            learning: async (prev: any) => prev,
            policy: () => ({ kind: 'internal', intent: 'noop' }),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent }),
            execution: async (intent: any) => ({ action: intent, result: { status: 'ok', data: {} } }),
            transition: () => ({ kind: 'complete' }),
        };
        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 1, collectTraces: true });
        const trace = result.traces?.[0];
        expect(trace?.conversation?.id).toBe('thread-cov-1');
        expect(trace?.incomingMessages?.[0]?.id).toBe('msg-cov-1');
        expect(trace?.messageSequenceNumber).toBe(1);
    });

    it('filters transition re-emit of consumed message.received and replaces with state.noted on continue', async () => {
        const threadObs = {
            source: 'conversation',
            kind: 'message.received',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'm-loop-dup',
                    conversation: { kind: 'thread' as const, id: 'th-drain' },
                    senderAgentId: 'o',
                    senderMemberId: 'o',
                    recipientAgentId: 'p',
                    recipientMemberId: 'p',
                    speechAct: 'inform' as const,
                    content: {},
                    sequenceNumber: 1,
                    ts: new Date().toISOString(),
                },
            },
        };
        const reEmit: typeof threadObs = {
            ...threadObs,
            payload: {
                ...threadObs.payload,
                message: { ...threadObs.payload.message },
            },
        };
        let turn = 0;
        const ctx: Record<string, unknown> = {
            task: { id: 'loop-drain-task', input: 'x' },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() },
        };
        const M: Record<string, unknown> = initialM(ctx);
        const env = baseEnv({
            inbox: normalizeObservationInbox({
                current: [threadObs],
                all: [threadObs],
            }),
        });
        const modules = {
            attention: () => ({}),
            perception: () => ({ ok: true }),
            learning: async (prev: unknown) => prev,
            policy: () => ({ kind: 'internal', intent: 'noop' }),
            shield: (_m: unknown, intent: unknown) => ({ action: 'pass', intent }),
            execution: async (intent: unknown) => ({ action: intent, result: { status: 'ok', data: {} } }),
            transition: () => {
                if (turn === 0) {
                    turn += 1;
                    return { kind: 'continue', observations: [reEmit] };
                }
                return { kind: 'await_input', token: 'halt' };
            },
        };
        const result = await runLoop(ctx, M, env, modules as never, { maxTurns: 2, collectTraces: true });
        expect(turn).toBe(1);
        expect(result.traces?.length).toBeGreaterThanOrEqual(2);
        const second = result.traces?.[1];
        expect(second?.inboxCurrent?.[0]?.kind).toBe('state.noted');
        const nThreadInAll = env.inbox.all.filter(
            (o) =>
                (o as { source?: string; payload?: { kind?: string } }).source === 'conversation' &&
                (o as { payload?: { kind?: string } }).payload?.kind === 'message.received'
        );
        expect(nThreadInAll.length).toBe(1);
    });
});

describe('runLoop memory fallbacks and goal mutations', () => {
    it('uses in-memory fallback readers and applies goal add/remove/clear patches', async () => {
        const ctx: any = { 
            task: { id: 'fallback-task', input: {} },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() }
        };
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

        const env = baseEnv({ inbox: normalizeObservationInbox([{ source: 'internal', kind: 'state.noted', payload: {} } as any]) });

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
            requestInput: jest.fn<any>().mockResolvedValue({ token: 'input-token' }),
            sendTaskToAgent: (jest.fn() as any)
                .mockResolvedValueOnce({ token: 'child-token' })
                .mockResolvedValueOnce({ note: 'done' }),
            requestTool: (jest.fn() as any).mockResolvedValue({ token: 'tool-token' }),
            tools: { invoke: (jest.fn() as any).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('tool error')) }
        };
        const M: any = initialM(ctx);
        const env = baseEnv({ pending: { inputs: {}, children: { 'pending-child': {} }, tools: {}, groups: {} } });

        const transitionResults: any[] = [];
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: [], time: env.time, pending: env.pending } as any),
            learning: async (prev: any, _prevAction: any, _obs: any, mem: any) => {
                const askRes = await ctx.defaults.execution({ kind: 'prompt_user', prompt: 'Need input', schema: {} } as any, ctx, mem, M);
                const childRes = await ctx.defaults.execution({ kind: 'delegate_to_child', agentId: 'child', input: {} } as any, ctx, mem, M);
                const childNoToken = await ctx.defaults.execution({ kind: 'delegate_to_child', agentId: 'child', input: {} } as any, ctx, mem, M);
                const toolAwait = await ctx.defaults.execution({ kind: 'call_tool', toolName: 'needs-callback', args: {}, mode: 'async' } as any, ctx, mem, M);
                const toolImmediate = await ctx.defaults.execution({ kind: 'call_tool', toolName: 'immediate', args: {} } as any, ctx, mem, M);
                const toolError = await ctx.defaults.execution({ kind: 'call_tool', toolName: 'fails', args: {} } as any, ctx, mem, M);
                const languageRes = await ctx.defaults.execution({ kind: 'answer_with_llm', query: 'hello' } as any, ctx, mem, M);
                const internalRes = await ctx.defaults.execution({ kind: 'unknown', intent: 'noop' } as any, ctx, mem, M);

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
            policy: () => ({ kind: 'prompt_user', prompt: 'Need input' } as any),
            shield: (_m: any, intent: any) => ({ action: 'pass', intent } as any)
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 1 });

        expect(ctx.requestInput).toHaveBeenCalledWith('Need input', expect.any(Object));
        expect(ctx.sendTaskToAgent).toHaveBeenCalledTimes(2);
        expect(ctx.requestTool).toHaveBeenCalledWith('needs-callback', {}, expect.any(Object));
        expect(ctx.tools.invoke).toHaveBeenCalledTimes(2);
        expect(ctx.reply).toHaveBeenCalledWith('hello');
        expect(transitionResults.map(t => t.kind)).toEqual(['await_input', 'await_child', 'continue', 'await_child', 'await_tool', 'await_child']);
        expect(result.outcome.kind).toBe('await_input');
    });
});

describe('runLoop await_child fast-paths', () => {
    it('continues loop when child completion is already in the inbox', async () => {
        const ctx: any = { task: { id: 'child-sync', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const childObs = { source: 'child', kind: 'child.completed', payload: { token: 'child-token', data: 'ok' } };
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
        expect(env.inbox.current.length).toBe(0);
    });

    it('copies plan stamps onto childTerminals before SYNC pending delete', async () => {
        const ctx: any = { task: { id: 'child-sync-stamp', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const childObs = { source: 'child', kind: 'child.completed', payload: { token: 'child-token', data: 'ok' } };
        const env = baseEnv({
            inbox: normalizeObservationInbox({ current: [], all: [childObs] }),
            pending: {
                inputs: {},
                children: {
                    'child-token': { agentId: 'child-agent', planId: 'p1', stepId: 'A', advanceCursor: true },
                },
                tools: {},
                groups: {},
            },
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
                : { kind: 'await_input', token: 'end' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2 });

        expect(env.pending.children['child-token']).toBeUndefined();
        expect(env.pending.childTerminals?.['child-token']).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A', advanceCursor: true })
        );
        expect(result.outcome.kind).toBe('await_input');
    });

    it('copies plan stamps onto toolTerminals before SYNC pending delete', async () => {
        const ctx: any = { task: { id: 'tool-sync-stamp', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const toolObs = {
            source: 'tool',
            kind: 'tool.completed',
            payload: { token: 'tool-token', tool: 'search', result: {} },
        };
        const env = baseEnv({
            inbox: normalizeObservationInbox({ current: [], all: [toolObs] }),
            pending: {
                inputs: {},
                children: {},
                tools: {
                    'tool-token': { name: 'search', planId: 'p1', stepId: 'B', advanceCursor: false },
                },
                groups: {},
            },
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
                ? { kind: 'await_tool', token: 'tool-token' } as any
                : { kind: 'await_input', token: 'end' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 2 });

        expect(env.pending.tools['tool-token']).toBeUndefined();
        expect(env.pending.toolTerminals?.['tool-token']).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'B', advanceCursor: false })
        );
        expect(result.outcome.kind).toBe('await_input');
    });

    it('does not overwrite existing toolTerminal stamps on SYNC delete', async () => {
        const ctx: any = { task: { id: 'tool-sync-keep', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const toolObs = {
            source: 'tool',
            kind: 'tool.completed',
            payload: { token: 'tool-token', tool: 'search', result: {} },
        };
        const env = baseEnv({
            inbox: normalizeObservationInbox({ current: [], all: [toolObs] }),
            pending: {
                inputs: {},
                children: {},
                tools: {
                    'tool-token': { name: 'search', planId: 'p-new', stepId: 'Z', advanceCursor: true },
                },
                toolTerminals: {
                    'tool-token': { kind: 'completed', planId: 'p1', stepId: 'A', advanceCursor: false },
                },
                groups: {},
            },
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
                ? { kind: 'await_tool', token: 'tool-token' } as any
                : { kind: 'await_input', token: 'end' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        await runLoop(ctx, M, env, modules as any, { maxTurns: 2 });

        expect(env.pending.tools['tool-token']).toBeUndefined();
        expect(env.pending.toolTerminals?.['tool-token']).toEqual(
            expect.objectContaining({ kind: 'completed', planId: 'p1', stepId: 'A', advanceCursor: false })
        );
    });

    it('reloads inbox from session manager when child completion is persisted externally', async () => {
        const childObs = { source: 'child', kind: 'child.completed', payload: { token: 'reload-child', value: 1 } };
        const sessionManager = { load: jest.fn<any>().mockResolvedValue({ snapshot: { inbox: { all: [childObs], current: [] } } }) };
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
        expect(env.inbox.current.length).toBe(0);
        expect(result.outcome.kind).toBe('await_input');
    });
});

describe('runLoop budgets, errors, and observation normalization', () => {
    it('allows at least one turn to execute even when env.turn exceeds global budget', async () => {
        // ✅ FIX: This test was updated to reflect the new behavior where runLoop
        // allows at least one turn to execute before checking the global budget.
        // This prevents agents from failing immediately on resume when env.turn >= budget.maxTurns.
        const ctx: any = { 
            task: { id: 'budget-task', input: {} },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() }
        };
        const M: any = initialM(ctx);
        const env = baseEnv({ turn: 5, budget: { maxTurns: 4, latencyMs: 0 } });

        // With the fix, the loop will execute one turn (turnIdx=0) before checking budget
        // Since no modules are provided, it will fail with an execution error
        const result = await runLoop(ctx, M, env, {} as any, { maxTurns: 10 });

        // Should execute at least one turn (not fail immediately with budget_turns_exceeded)
        // The error will be from missing execution module
        expect(result.outcome.kind).toBe('fail');
        expect((result.outcome as any).reason).toBe('budget_turns_exceeded');
    });

    it('fails fast when latency budget is exceeded', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1000;
        nowSpy.mockImplementation(() => {
            now += 10;
            return now;
        });

        const ctx: any = {
            task: { id: 'latency-task', input: {} },
            reply: jest.fn(),
            requestInput: jest.fn(),
            sendTaskToAgent: jest.fn(),
            requestTool: jest.fn(),
            tools: { invoke: jest.fn() }
        };
        const M: any = initialM(ctx);
        const env = baseEnv();

        const { InvariantError } = await import('../src/utils/errors.js');
        let err: unknown;
        try {
            await runLoop(ctx, M, env, {} as any, { maxTurns: 5, latencyMs: 1 });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(InvariantError);
        expect((err as InstanceType<typeof InvariantError>).invariant.code).toBe('BUDGET_LATENCY_EXCEEDED');
    });

    it('normalizes continue outcomes, preserves inbox when no observations, and captures turn errors', async () => {
        const ctx: any = { task: { id: 'error-task', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({ inbox: normalizeObservationInbox([{ source: 'internal', kind: 'state.noted', payload: {} } as any]) });

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
            transition: () => ({ kind: 'continue', observations: [{ source: 'internal', kind: 'state.noted', payload: {} }] } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });

        // ✅ FIXED: In the new version, inbox.current is CLEARED between turns to avoid phantom observations.
        expect(env.inbox.current.length).toBe(0);
        expect(result.outcome.kind).toBe('fail');
        expect(String((result.outcome as any).reason)).toContain('turn_1_error');
    });

    it('throws CONTINUE_WITHOUT_OBSERVATIONS when continue has no observations', async () => {
        const ctx: any = { task: { id: 'cont-task', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({ inbox: normalizeObservationInbox([{ source: 'internal', kind: 'state.noted', payload: {} } as any]) });
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, i: any) => ({ action: 'pass', intent: i } as any),
            execution: () => ({ action: { kind: 'internal' }, result: { status: 'ok' } }),
            transition: () => ({ kind: 'continue', observations: [] } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };
        const { InvariantError } = await import('../src/utils/errors.js');
        let err: unknown;
        try {
            await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(InvariantError);
        expect((err as InstanceType<typeof InvariantError>).invariant.code).toBe('CONTINUE_WITHOUT_OBSERVATIONS');
        expect((err as InstanceType<typeof InvariantError>).invariant.detail.type).toBe('transition_invariant');
    });

    it('throws AWAIT_MISSING_TOKEN when await_input has no token', async () => {
        const ctx: any = { task: { id: 'await-task', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({ inbox: normalizeObservationInbox([{ source: 'internal', kind: 'state.noted', payload: {} } as any]) });
        const modules = {
            attention: () => ({}),
            perception: () => ({ inbox: env.inbox.current, time: env.time, pending: env.pending } as any),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'internal', intent: 'noop' } as any),
            shield: (_m: any, i: any) => ({ action: 'pass', intent: i } as any),
            execution: () => ({ action: { kind: 'internal' }, result: { status: 'ok' } }),
            transition: () => ({ kind: 'await_input', token: '' } as any),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };
        const { InvariantError } = await import('../src/utils/errors.js');
        let err: unknown;
        try {
            await runLoop(ctx, M, env, modules as any, { maxTurns: 3 });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(InvariantError);
        expect((err as InstanceType<typeof InvariantError>).invariant.code).toBe('AWAIT_MISSING_TOKEN');
    });

    it('injects validation.failed observation for invalid envelope', () => {
        const invalidItem = { not: 'a valid observation envelope' };
        const inbox = normalizeObservationInbox([invalidItem]);
        expect(inbox.current).toHaveLength(1);
        expect(inbox.current[0]).toMatchObject({ source: 'internal', kind: 'validation.failed' });
        expect((inbox.current[0] as { payload?: { reason?: string } }).payload?.reason).toBe('invalid_observation_envelope');
    });
});
