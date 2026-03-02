/**
 * Test to reproduce LoopRunner bug:
 * LoopRunner starts but exits immediately without executing turns
 * when env.turn >= env.budget.maxTurns on entry
 *
 * Bug: The global budget check happens BEFORE the first turn can execute,
 * causing agents to fail immediately if they've been resumed/restarted.
 */

import { runLoop } from '../src/loop/loopRunner.js';
import type { MentalState, EnvironmentState } from '../src/loop/types.js';

describe('LoopRunner Bug: Global Budget Check on First Iteration', () => {
    it('should execute at least one turn even when env.turn >= globalMaxTurns on entry', async () => {
        const mockCtx = {
            task: { id: 'test-task-budget-bug' },
            agentId: 'test-agent',
            memory: {
                semantic: { read: async () => [] },
                episodic: { range: async () => [] }
            },
            telemetry: {
                nodeId: null,
                registerNode: () => {}
            }
        } as any;

        // Simulate a resumed/restarted agent where env.turn is already HIGH
        // BUG SCENARIO: env.turn = 11, budget.maxTurns = 10
        // The loop will exit immediately because 11 > 10
        const mockEnv: EnvironmentState = {
            turn: 11,  // Already EXCEEDS max turns!
            inbox: {
                current: [{
                    source: 'user',
                    kind: 'input.provided',
                    payload: { test: 'data' },
                    provenance: { ts: Date.now(), turn: 11 }
                }],
                all: []
            },
            budget: {
                maxTurns: 10  // Budget says max 10 turns
            },
            control: {}
        } as any;

        const mockM: MentalState = {
            memory: {
                sensory: {},
                vars: {},
                longTerm: {
                    semantic: { concepts: [] },
                    episodic: [],
                    procedural: { skills: [] }
                }
            },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0 },
            rewardParams: { extrinsicWeights: [1], intrinsic: {}, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false },
            vars: {}
        };

        let modulesCalled = false;
        const mockModules = {
            attention: () => ({ hasInput: true }),
            perception: () => ({ source: 'internal', kind: 'test', payload: {} }),
            learning: (m: any) => m,
            policy: () => ({ kind: 'internal', done: true }),
            shield: (m: any, a: any) => ({ action: 'pass', intent: a }),
            execution: async () => ({
                action: { kind: 'internal', done: true },
                result: { status: 'ok', data: { kind: 'final_complete', result: { test: 'success' } } }
            }),
            transition: () => ({ kind: 'complete', result: { test: 'success' } })
        };

        // Call runLoop with opts.maxTurns = 10
        // The bug: loop will exit immediately because turn (11) > globalMaxTurns (10)
        console.log('BEFORE runLoop: env.turn =', mockEnv.turn, ', budget.maxTurns =', mockEnv.budget.maxTurns);
        const result = await runLoop(mockCtx, mockM, mockEnv, mockModules, { maxTurns: 10 });
        console.log('AFTER runLoop: env.turn =', mockEnv.turn);
        console.log('Result outcome kind:', result.outcome.kind);

        // BUG: If bug exists, outcome will be 'fail' with reason 'budget_turns_exceeded'
        // WITHOUT executing any modules
        if (result.outcome.kind === 'fail' && result.outcome.reason === 'budget_turns_exceeded') {
            console.log('❌ BUG CONFIRMED: Loop exited due to budget check without executing any turns');
            console.log('   This is the bug - loop should have executed at least one turn');
        } else {
            console.log('✅ Loop executed normally');
        }

        // The fix should allow at least ONE turn to execute before checking budget
        // or track budget differently
    });

    it('should track budget based on turns executed in THIS runLoop call, not cumulative env.turn', async () => {
        const mockCtx = {
            task: { id: 'test-task-budget-tracking' },
            agentId: 'test-agent',
            memory: {
                semantic: { read: async () => [] },
                episodic: { range: async () => [] }
            },
            telemetry: {
                nodeId: null,
                registerNode: () => {}
            }
        } as any;

        const mockEnv: EnvironmentState = {
            turn: 5,  // Already executed 5 turns previously
            inbox: {
                current: [{
                    source: 'user',
                    kind: 'input.provided',
                    payload: { test: 'data' },
                    provenance: { ts: Date.now(), turn: 5 }
                }],
                all: []
            },
            budget: {
                maxTurns: 10  // Allow 10 more turns
            },
            control: {}
        } as any;

        const mockM: MentalState = {
            memory: {
                sensory: {},
                vars: {},
                longTerm: {
                    semantic: { concepts: [] },
                    episodic: [],
                    procedural: { skills: [] }
                }
            },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0 },
            rewardParams: { extrinsicWeights: [1], intrinsic: {}, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false },
            vars: {}
        };

        let turnsExecuted = 0;
        const mockModules = {
            attention: () => ({ hasInput: true }),
            perception: () => ({ source: 'internal', kind: 'test', payload: {} }),
            learning: (m: any) => m,
            policy: () => ({ kind: 'internal', done: false }),
            shield: (m: any, a: any) => ({ action: 'pass', intent: a }),
            execution: async () => {
                turnsExecuted++;
                return {
                    action: { kind: 'internal', done: false },
                    result: { status: 'ok' }
                };
            },
            transition: () => ({ kind: 'continue' })
        };

        // Request 3 more turns
        const result = await runLoop(mockCtx, mockM, mockEnv, mockModules, { maxTurns: 3 });

        // Should execute 3 turns (not fail due to env.turn=5 being < budget.maxTurns=10)
        // OR should properly track that we want 3 more turns
        console.log('Turns executed:', turnsExecuted);
        console.log('Final env.turn:', mockEnv.turn);
        console.log('Outcome:', result.outcome);

        // The fix needs to clarify: is budget.maxTurns a TOTAL limit or PER-RUNLOOP limit?
    });
});
