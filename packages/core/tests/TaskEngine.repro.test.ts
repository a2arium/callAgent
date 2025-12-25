
import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { MentalState, EnvironmentState } from '../src/loop/types.js';

describe('LoopRunner Sync Child Reproduction', () => {

    it('Scenario 1: Loop continues to next turn after sync child (verify continue)', async () => {
        const ctx = {
            task: { id: 'test-task', input: {} },
            agentId: 'test-agent',
            logger: console
        } as unknown as TaskContext;

        const M = {
            memory: { vars: {} }
        } as unknown as MentalState;

        const env = {
            turn: 0,
            inbox: { current: [], all: [] },
            pending: {},
            budget: { maxTurns: 10 }
        } as unknown as EnvironmentState;

        let localTurn = 0;

        // Mock simplified modules
        const overrides = {
            perception: async () => ({ inbox: env.inbox, pending: env.pending }),
            learning: async (params: any) => params.M, // identity
            policy: (m: any) => {
                // Turn 0: Dispatch Subagent
                // Turn 1: Done
                // We must use a local counter since env.turn will NOT increment for sync children with the new fix
                localTurn++;
                if (localTurn === 1) {
                    return { kind: 'subagent', target: 'child', input: {} } as const;
                }
                return { kind: 'internal', intent: 'finish' } as const;
            },
            execution: async (action: any) => {
                if (action.kind === 'subagent') {
                    // Logic normally calls sendTaskToAgent.
                    // We assume ApiBinder logic ran and injected result into inbox synchronously
                    // So we simulate that side-effect here:
                    const token = 'child-token-123';
                    const obs = {
                        kind: 'child.completed',
                        payload: { token, result: { done: true } }
                    };
                    env.inbox.current.push(obs as any);
                    env.inbox.all.push(obs as any);
                    env.pending = { ...env.pending, children: { [token]: {} } };

                    return {
                        action: { kind: 'subagent' as const, token },
                        result: { status: 'ok' as const }
                    };
                }
                return { action: { kind: 'internal' as const, done: true }, result: { status: 'ok' as const, data: { done: true } } };
            },
            transition: (env: any, exec: any) => {
                if (exec.action.kind === 'internal' && exec.action.done) {
                    return { kind: 'complete' as const, outcome: exec.result.data };
                }
                if (exec.action.kind === 'subagent' && exec.action.token) {
                    return { kind: 'await_child' as const, token: exec.action.token };
                }
                return { kind: 'continue' as const, observations: [] };
            }
        };

        const result = await runLoop(ctx, M, env, overrides, { maxTurns: 10 });

        // Validation
        // It should have run Turn 0 (Sync Child) -> Continue -> Turn 1 (Done)
        expect(result.outcome.kind).toBe('complete');
    });

    it('Scenario 2: MaxTurns limits the loop even with continue', async () => {
        const ctx = {
            task: { id: 'test-task', input: {} },
            agentId: 'test-agent',
            logger: console
        } as unknown as TaskContext;

        const M = { memory: { vars: {} } } as unknown as MentalState;

        // Start with env.turn = 0
        const env = {
            turn: 0,
            inbox: { current: [], all: [] },
            pending: {},
            budget: { maxTurns: 20 } // Budget of 20 turns
        } as unknown as EnvironmentState;

        let localTurn2 = 0;
        let tokenCounter = 0;

        const overrides = {
            perception: async () => {
                // Mimic default perception/ensureInbox behavior: it replaces env.inbox with a new object
                const nextInbox = { current: [...env.inbox.current], all: [...env.inbox.all] } as any;
                env.inbox = nextInbox;
                return { inbox: nextInbox, pending: env.pending };
            },
            learning: async (params: any) => params.M,
            policy: (m: any) => {
                localTurn2++;
                if (localTurn2 <= 5) {
                    return { kind: 'subagent', target: 'child', input: {} } as const;
                }
                return { kind: 'internal', intent: 'finish', done: true } as const;
            },
            execution: async (action: any) => {
                if (action.kind === 'subagent') {
                    // Simulate sync child injection via ApiBinder (which uses stale __activeLoopInbox)
                    tokenCounter++;
                    const token = 'child-token-' + tokenCounter;
                    const obs = { kind: 'child.completed', payload: { token, result: { done: true } } };

                    // CRITICAL REPRODUCTION DETAIL: ApiBinder writes to __activeLoopInbox (stale), not env.inbox (fresh)
                    const binderInbox = (ctx as any).__activeLoopInbox;
                    if (binderInbox) {
                        binderInbox.current.push(obs as any);
                        binderInbox.all.push(obs as any);
                    } else {
                        // Fallback if not set (should be set by loopRunner)
                        env.inbox.current.push(obs as any);
                        env.inbox.all.push(obs as any);
                    }
                    return { action: { kind: 'subagent' as const, token }, result: { status: 'ok' as const } };
                }
                return { action: { kind: 'internal' as const, done: true }, result: { status: 'ok' as const, data: { done: true } } };
            },
            transition: (env: any, exec: any) => {
                if (exec.action.kind === 'internal' && exec.action.done) {
                    return { kind: 'complete' as const, outcome: exec.result.data };
                }
                if (exec.action.kind === 'subagent' && exec.action.token) {
                    return { kind: 'await_child' as const, token: exec.action.token };
                }
                return { kind: 'continue' as const, observations: [] };
            }
        };

        // maxTurns passed to runLoop logic
        const result = await runLoop(ctx, M, env, overrides, { maxTurns: 20 });

        // Logic:
        // Loop 0 uses the ONLY allowed turn.
        // It does "Sync Child" -> Continue.
        // It tries to go to Loop 1.
        // Loop 1 matches maxTurns check (1 < 1) -> False.
        // Ends.
        // Result returned is { kind: 'complete', ... } because turn-- allowed us to proceed to Turn 1 (Done) within budget

        expect(result.outcome.kind).toBe('complete');

        // CRITICAL REPRODUCTION ASSERTION:
        // The agent's environment (env.inbox) should contain the child completion observations.
        // Due to the bug (ApiBinder writing to stale inbox), this is expected to FAIL before the fix.
        // We check if *any* child completion made it into the final env.inbox.
        const hasCompletion = env.inbox.all.some((o: any) => o.kind === 'child.completed');
        expect(hasCompletion).toBe(true);
    });

    it('Scenario 3: MaxTurns=Infinity allows loop to proceed', async () => {
        const ctx = {
            task: { id: 'test-task', input: {} },
            agentId: 'test-agent',
            logger: console
        } as unknown as TaskContext;

        const M = { memory: { vars: {} } } as unknown as MentalState;

        const env = {
            turn: 0,
            inbox: { current: [], all: [] },
            pending: {},
            budget: { maxTurns: 2 } // Budget for checks inside loop
        } as unknown as EnvironmentState;

        let turnCount = 0;

        const overrides = {
            perception: async () => ({ inbox: env.inbox, pending: env.pending }),
            learning: async (params: any) => params.M,
            policy: (m: any) => {
                turnCount++;
                if (turnCount === 1) return { kind: 'subagent', target: 'child', input: {} } as const;
                return { kind: 'internal', intent: 'finish' } as const;
            },
            execution: async (action: any) => {
                if (action.kind === 'subagent') {
                    const token = 'child-token-inf';
                    const obs = { kind: 'child.completed', payload: { token, result: { done: true } } };
                    env.inbox.current.push(obs as any);
                    env.inbox.all.push(obs as any);
                    return { action: { kind: 'subagent' as const, token }, result: { status: 'ok' as const } };
                }
                return { action: { kind: 'internal' as const, done: true }, result: { status: 'ok' as const, data: { done: true } } };
            },
            transition: (env: any, exec: any) => {
                if (exec.action.kind === 'internal' && exec.action.done) {
                    return { kind: 'complete' as const, outcome: exec.result.data };
                }
                if (exec.action.kind === 'subagent' && exec.action.token) {
                    return { kind: 'await_child' as const, token: exec.action.token };
                }
                return { kind: 'continue' as const, observations: [] };
            }
        };

        // Pass Infinity explicitly
        const result = await runLoop(ctx, M, env, overrides, { maxTurns: Infinity });

        expect(result.outcome.kind).toBe('complete');
        expect(turnCount).toBe(2);
    });
});
