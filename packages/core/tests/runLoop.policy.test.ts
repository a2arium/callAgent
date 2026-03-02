import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import type { EnvironmentState } from '../src/loop/types.js';

const baseEnv = (overrides: Partial<EnvironmentState> = {}): EnvironmentState => ({
    time: new Date().toISOString(),
    sessionId: 'policy-session',
    turn: 0,
    budget: { maxTurns: 1, latencyMs: 0 },
    pending: { inputs: {}, children: {}, tools: {}, groups: {} },
    inbox: { current: [], all: [] } as any,
    lastExec: undefined,
    ...overrides
});

describe('runLoop default policy and shield branches', () => {
    it('dispatches react-planner tool action using default policy', async () => {
        const ctx: any = { task: { id: 'policy-react', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        M.policyParams.reactPlanner = {
            enabled: true,
            patterns: [{ regex: '(ping)', tool: 'echo', argKey: 'msg' }]
        };
        M.memory = M.memory || {};
        M.memory.sensory = { lastObservation: 'ping me' };
        M.memory.scratch = { react: { lastResult: { prev: true } } };

        const execution = jest.fn(async (action: any) => ({
            action: { kind: 'ask_user', token: 'react-token' },
            result: { status: 'ok', data: action }
        }));

        const result = await runLoop(
            ctx,
            M,
            baseEnv(),
            {
                attention: () => ({}),
                perception: () => ({ input: 'ping me' }),
                learning: (prev: any) => prev,
                execution,
                transition: () => ({ kind: 'await_input', token: 'react-token' } as any)
            } as any,
            { maxTurns: 1 }
        );

        const calledWith = execution.mock.calls[0]?.[0];
        expect(calledWith).toMatchObject({ kind: 'tool', name: 'echo' });
        expect((calledWith as any).args).toMatchObject({ msg: 'ping', context: { prev: true } });
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('react-token');
    });

    it('defers tools under guardrails HITL level', async () => {
        const ctx: any = { task: { id: 'policy-guardrails', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        M.hitl = 'guardrails';

        const execution = jest.fn(async (action: any) => ({
            action: { kind: 'ask_user', token: 'guardrails-token' },
            result: { status: 'ok', data: action }
        }));

        const result = await runLoop(
            ctx,
            M,
            baseEnv(),
            {
                policy: () => ({ kind: 'tool', name: 't', args: {} }),
                execution
            } as any,
            { maxTurns: 1 }
        );

        expect(execution).toHaveBeenCalled();
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('guardrails-token');
        expect(result.M.lastAdvise).toMatchObject({ kind: 'tool', policy: 'guardrails' });
    });

    it('asks consent before running tool actions', async () => {
        const ctx: any = { task: { id: 'policy-consent', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        M.hitl = 'consent';

        const execution = jest.fn(async (action: any) => ({
            action: { kind: 'ask_user', token: 'consent-token' },
            result: { status: 'ok', data: action }
        }));

        const result = await runLoop(
            ctx,
            M,
            baseEnv(),
            {
                policy: () => ({ kind: 'tool', name: 'db-write', args: { foo: 'bar' } }),
                execution
            } as any,
            { maxTurns: 1 }
        );

        expect(execution).toHaveBeenCalled();
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('consent-token');
        expect(result.M.lastAdvise).toMatchObject({ kind: 'tool', tool: 'db-write', policy: 'consent' });
    });

    it('returns await_child when pending children exist even if execution returned internal', async () => {
        const ctx: any = { task: { id: 'policy-pending-child', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        const env = baseEnv({
            pending: { inputs: {}, tools: {}, groups: {}, children: { 'child-token': {} } } as any
        });

        const execution = jest.fn(async () => ({
            action: { kind: 'internal', done: true },
            result: { status: 'ok' }
        }));

        const result = await runLoop(
            ctx,
            M,
            env,
            { policy: () => ({ kind: 'internal', intent: 'noop' }), execution } as any,
            { maxTurns: 1 }
        );

        expect(result.outcome.kind).toBe('await_child');
        expect((result.outcome as any).token).toBe('child-token');
    });
});
