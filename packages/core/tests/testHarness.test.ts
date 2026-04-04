import { createTestHarness } from '../src/testing/TestHarness.js';
import { HarnessAssertionError } from '../src/testing/HarnessAssertions.js';
import type { Modules } from '../src/loop/oneTurn.js';
import { InvariantError } from '../src/utils/errors.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from '../src/loop/types.js';
import type { Intent } from '../src/types/intent.js';
import type { ExecOutcome, ExecResult } from '../src/types/execOutcome.js';
import type { Observation } from '../src/types/observation.js';
import { createStageFacade } from '../src/loop/stageHelpers.js';

type Sensory = { userInput?: string; seeded?: boolean };

describe('TestHarness', () => {
    /**
     * Module signatures (from `Modules<Sensory>` type):
     *   attention:  (mPrev, env, mem) => Alpha
     *   perception: (env, alpha, mem) => Obs
     *   learning:   (mPrev, prevAction, o, mem, writer, rPrev) => MentalState
     *   policy:     (m, mem) => Intent | Array<{action, prob}>
     *   shield:     (m, a, mem) => ShieldOutcome
     *   execution:  (a, ctx, mem, m) => ExecOutcome
     *   transition: (env, exec, m, mem) => TransitionOut
     */
    const mockModules: Partial<Modules<Sensory>> = {
        attention: (_mPrev: MentalState<Sensory>, _env: EnvironmentState, _mem: MemoryReader) => {
            return 'alpha';
        },
        perception: (env: EnvironmentState, _alpha: unknown, _mem: MemoryReader) => {
            const last = env.inbox?.current?.[env.inbox.current.length - 1] as Observation | undefined;
            if (last && last.source === 'user') {
                return { userInput: (last.payload as { value?: string }).value };
            }
            return {};
        },
        learning: (
            mPrev: MentalState<Sensory>,
            _prevAction: Intent | undefined,
            o: unknown,
            _mem: MemoryReader,
            _writer: MemoryWriter,
        ) => {
            const obs = o as { userInput?: string };
            const m = { ...mPrev };
            if (obs.userInput) {
                m.sensory = { ...m.sensory, userInput: obs.userInput } as Sensory;
            }
            return m;
        },
        policy: (m: MentalState<Sensory>, _mem: MemoryReader) => {
            if (m.sensory?.userInput) {
                return { kind: 'call_tool', params: { tool: 'search' } } as Intent;
            }
            return { kind: 'answer_with_llm' } as Intent;
        },
        shield: (_m: MentalState<Sensory>, a: Intent, _mem: MemoryReader) => {
            return { action: 'pass' as const, intent: a };
        },
        execution: async (a: Intent, _ctx: TaskContext, _mem: MemoryReader, _m: MentalState<Sensory>): Promise<ExecOutcome> => {
            return {
                action: a,
                result: { status: 'ok', data: null } as ExecResult,
            };
        },
        transition: (
            _env: EnvironmentState,
            exec: ExecOutcome,
            m: MentalState<Sensory>,
            _mem: MemoryReader,
        ) => {
            if (m.sensory?.userInput) {
                return { kind: 'await_tool' as const, token: 'await-me' };
            }
            return { kind: 'complete' as const };
        },
    };

    it('creates and runs a turn successfully', async () => {
        const h = createTestHarness(mockModules);

        await h.runTurn(); // Will path to intent='answer_with_llm' -> transition='complete'

        expect(h.allTraces()).toHaveLength(1);

        h.expectTurn(t => {
            t.expectIntent('answer_with_llm');
            t.expectTransition('complete');
        });

        h.expectComplete();
    });

    it('seeds state successfully', () => {
        const h = createTestHarness<Sensory>(mockModules);

        h.seedMentalState({ memory: { sensory: { seeded: true } as Sensory } });
        expect(h.currentM().memory.sensory?.seeded).toBe(true);

        h.seedPending({ inputs: { 'some-tok': {} } });
    });

    it('injects observation and impacts the turn execution', async () => {
        const h = createTestHarness(mockModules);

        h.injectUserInput('hello');

        await h.runTurn(); // intent='call_tool' -> transition='await_tool'

        h.expectTurn(t => {
            t.expectIntent('call_tool');
            t.expectTransition('await_tool');
            t.expectAwaitToken('await-me');
        });

        expect(h.lastAwaitToken()).toBe('await-me');
    });

    it('multi-turn chronological execution', async () => {
        const h = createTestHarness(mockModules);

        await h.injectUserInput('hello').runTurn();
        h.expectTurn(t => t.expectTransition('await_tool'));

        // In the second turn the inbox has 'tool.completed'. It is not 'user', so
        // perception won't add userInput. But learning preserves the previous m.sensory.
        // So the policy still picks 'call_tool' based on the existing m.sensory.userInput.
        await h.injectToolCompleted({ token: 'await-me', tool: 'search', result: 'found it' }).runTurn();

        expect(h.allTraces()).toHaveLength(2);
    });

    it('throws descriptive HarnessAssertionErrors on mismatch', async () => {
        const h = createTestHarness(mockModules);
        await h.runTurn(); // complete

        expect(() => {
            h.expectTurn(t => t.expectIntent('call_tool'));
        }).toThrow(HarnessAssertionError);

        expect(() => {
            h.expectTurn(t => t.expectIntent('call_tool'));
        }).toThrow(/expected intent.kind to be "call_tool"/);

        expect(() => h.expectFail()).toThrow(HarnessAssertionError);
    });

    it('captures invariant errors and fails turn', async () => {
        // Override the learning module to throw an InvariantError when the user sends 'bad'
        const invariantModules: Partial<Modules<Sensory>> = {
            ...mockModules,
            learning: (
                mPrev: MentalState<Sensory>,
                _prevAction: Intent | undefined,
                o: unknown,
                _mem: MemoryReader,
                _writer: MemoryWriter,
            ) => {
                const obs = o as { userInput?: string };
                if (obs.userInput === 'bad') {
                    throw new InvariantError({
                        code: 'TOKEN_MISMATCH',
                        message: 'bad input',
                        detail: {
                            type: 'token_validation',
                            category: 'input',
                            reason: 'missing',
                        },
                    });
                }
                const m = { ...mPrev };
                if (obs.userInput) {
                    m.sensory = { ...m.sensory, userInput: obs.userInput } as Sensory;
                }
                return m;
            },
        };

        const h = createTestHarness(invariantModules);

        h.injectUserInput('bad'); // Triggers InvariantError in learning
        await h.runTurn();

        h.expectTurn(t => {
            t.expectStageAfter('failed');
            t.expectStageBefore('idle');
        });

        h.expectInvariantError(e => {
            expect(e).toBeInstanceOf(InvariantError);
            expect(e.message).toBe('bad input');
        });
    });

    it('captures stage from Stage.set in turn trace', async () => {
        const Stage = createStageFacade({
            stages: ['idle', 'fetching_html'] as const,
            initial: 'idle',
        });
        const modules: Partial<Modules<Sensory>> = {
            ...mockModules,
            execution: async (_a, ctx, _mem, _m): Promise<ExecOutcome> => {
                Stage.set(ctx, 'fetching_html');
                return {
                    action: { kind: 'internal', intent: 'noop' } as Intent,
                    result: { status: 'ok', data: null } as ExecResult,
                };
            },
            transition: () => ({ kind: 'complete' as const }),
        };

        const h = createTestHarness(modules);
        await h.runTurn();
        h.expectTurn(t => t.expectStageAfter('fetching_html'));
    });

    it('preserves sensory memory across turns', async () => {
        type CaseSensory = { caseId?: string };
        const modules: Partial<Modules<CaseSensory>> = {
            attention: () => 'alpha',
            perception: (env) => {
                const last = env.inbox?.current?.[env.inbox.current.length - 1];
                if (last?.source === 'user' && last.kind === 'input.provided') {
                    return { caseId: (last.payload as { value?: string }).value };
                }
                return {};
            },
            learning: (mPrev, _prevAction, o) => {
                const next = { ...mPrev };
                const observed = o as { caseId?: string };
                if (observed.caseId) {
                    next.sensory = { ...(next.sensory || {}), caseId: observed.caseId };
                }
                return next;
            },
            policy: () => ({ kind: 'internal', intent: 'noop' } as Intent),
            shield: (_m, a) => ({ action: 'pass', intent: a }),
            execution: async (_a) => ({
                action: { kind: 'internal', intent: 'noop' } as Intent,
                result: { status: 'ok', data: null } as ExecResult,
            }),
            transition: () => ({ kind: 'complete' as const }),
        };

        const h = createTestHarness<CaseSensory>(modules);
        await h.injectUserInput('CASE-42').runTurn();
        await h.runTurn();

        expect(h.currentM().sensory?.caseId).toBe('CASE-42');
    });

    it('increments turn numbering across consecutive runTurn calls', async () => {
        const h = createTestHarness(mockModules);
        await h.runTurn();
        await h.runTurn();
        await h.runTurn();

        const turns = h.allTraces().map(trace => trace.turn);
        expect(turns).toEqual([0, 1, 2]);
    });

    it('does not treat single-turn continue as a harness failure', async () => {
        const continueModules: Partial<Modules<Sensory>> = {
            ...mockModules,
            transition: () => ({
                kind: 'continue',
                observations: [{ source: 'internal', kind: 'state.noted', payload: { reason: 'keep_going' } }],
            }),
        };

        const h = createTestHarness(continueModules);
        await h.runTurn();

        h.expectTurn(t => t.expectTransition('continue'));
        expect(h.lastTrace().stageAfter).toBe('idle');
    });

    it('keeps continue transition observations in inbox for the next runTurn', async () => {
        const inboxAtPerception: Observation[][] = [];
        let turnIdx = 0;
        const modules: Partial<Modules<Sensory>> = {
            ...mockModules,
            perception: (env: EnvironmentState, alpha: unknown, mem: MemoryReader) => {
                inboxAtPerception.push([...env.inbox.current]);
                return mockModules.perception!(env, alpha, mem);
            },
            transition: () => {
                turnIdx += 1;
                if (turnIdx === 1) {
                    return {
                        kind: 'continue' as const,
                        observations: [
                            {
                                source: 'internal',
                                kind: 'state.noted',
                                payload: { step: 'after_continue' },
                            },
                        ],
                    };
                }
                return { kind: 'complete' as const };
            },
        };

        const h = createTestHarness(modules);
        await h.runTurn();
        await h.runTurn();

        expect(inboxAtPerception[0]).toHaveLength(0);
        expect(inboxAtPerception[1].map((o) => o.kind)).toContain('state.noted');
    });

    it('preserves sensory memory across turns when transition is continue', async () => {
        type CaseSensory = { siteId?: string };
        const modules: Partial<Modules<CaseSensory>> = {
            attention: () => 'alpha',
            perception: (env) => {
                const last = env.inbox?.current?.[env.inbox.current.length - 1];
                if (last?.source === 'user' && last.kind === 'input.provided') {
                    return { siteId: (last.payload as { value?: string }).value };
                }
                return {};
            },
            learning: (mPrev, _prevAction, o) => {
                const next = { ...mPrev };
                const observed = o as { siteId?: string };
                if (observed.siteId) {
                    next.sensory = { ...(next.sensory || {}), siteId: observed.siteId };
                }
                return next;
            },
            policy: () => ({ kind: 'internal', intent: 'load_case' } as Intent),
            shield: (_m, a) => ({ action: 'pass', intent: a }),
            execution: async (_a) => ({
                action: { kind: 'internal', intent: 'load_case' } as Intent,
                result: { status: 'ok', data: null } as ExecResult,
            }),
            transition: () => ({
                kind: 'continue' as const,
                observations: [{ source: 'internal', kind: 'state.noted', payload: { loaded: true } }],
            }),
        };

        const h = createTestHarness<CaseSensory>(modules);
        await h.injectUserInput('SITE-7').runTurn();

        // The critical assertion: sensory memory must survive the continue+budget path
        expect(h.currentM().sensory?.siteId).toBe('SITE-7');

        // Second turn should still have it
        await h.runTurn();
        expect(h.currentM().sensory?.siteId).toBe('SITE-7');
    });

    it('captures stage trace correctly when transition is continue', async () => {
        const Stage = createStageFacade({
            stages: ['idle', 'fetching_html'] as const,
            initial: 'idle',
        });
        const modules: Partial<Modules<Sensory>> = {
            ...mockModules,
            execution: async (_a, ctx, _mem, _m): Promise<ExecOutcome> => {
                Stage.set(ctx, 'fetching_html');
                return {
                    action: { kind: 'internal', intent: 'noop' } as Intent,
                    result: { status: 'ok', data: null } as ExecResult,
                };
            },
            transition: () => ({
                kind: 'continue' as const,
                observations: [{ source: 'internal', kind: 'state.noted', payload: { step: 1 } }],
            }),
        };

        const h = createTestHarness(modules);
        await h.runTurn();

        h.expectTurn(t => {
            t.expectTransition('continue');
            t.expectStageAfter('fetching_html');
        });
    });
});
