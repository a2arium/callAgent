import type { Modules } from '../loop/oneTurn.js';
import type { Observation } from '../types/observation.js';
import type { MentalState, EnvironmentState } from '../loop/types.js';
import type { TurnTrace } from '../types/turnTrace.js';
import { runLoop } from '../loop/loopRunner.js';
import { initialM } from '../loop/init.js';
import { normalizeObservationInbox } from '../loop/types.js';
import { HarnessConfigSchema, type HarnessConfig, type HarnessState, type DeepPartial, type TurnAssertionContext } from './harnessTypes.js';
import { createDeterministicLLMStub, createDeterministicToolStub, type DeterministicLLMStub, type DeterministicToolStub } from './DeterministicStubs.js';
import { createTestContext } from './TestContext.js';
import { createTurnAssertionContext, HarnessAssertionError } from './HarnessAssertions.js';
import { InvariantError, ModuleExecutionError } from '../utils/errors.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';

export type TestHarness<Sensory = unknown> = {
    seedMentalState(m: DeepPartial<MentalState<Sensory>>): TestHarness<Sensory>;
    seedPending(pending: Partial<EnvironmentState['pending']>): TestHarness<Sensory>;
    seedControlVars(vars: Record<string, unknown>): TestHarness<Sensory>;

    injectObservation(obs: Observation): TestHarness<Sensory>;
    injectUserInput(value: unknown): TestHarness<Sensory>;
    injectToolCompleted(params: { token: string; tool: string; result?: unknown }): TestHarness<Sensory>;
    injectToolFailed(params: { token: string; tool: string; error?: unknown }): TestHarness<Sensory>;
    injectChildCompleted(params: { token: string; agentId: string; result?: unknown }): TestHarness<Sensory>;
    injectChildFailed(params: { token: string; agentId: string; error?: unknown }): TestHarness<Sensory>;

    runTurn(): Promise<TestHarness<Sensory>>;

    expectTurn(fn: (t: TurnAssertionContext) => void): TestHarness<Sensory>;
    expectComplete(): TestHarness<Sensory>;
    expectFail(): TestHarness<Sensory>;
    expectInvariantError(fn: (e: InvariantError) => void): TestHarness<Sensory>;
    expectModuleError(fn: (e: ModuleExecutionError) => void): TestHarness<Sensory>;

    lastTrace(): TurnTrace;
    lastAwaitToken(): string;
    allTraces(): readonly TurnTrace[];
    currentM(): Readonly<MentalState<Sensory>>;
    replies(): readonly unknown[];
    llmStub(): DeterministicLLMStub;
    toolStub(): DeterministicToolStub;
};

// Deep merge utility
function isObject(item: unknown): item is Record<string, unknown> {
    return item !== null && typeof item === 'object' && !Array.isArray(item);
}

function mergeDeep(target: any, source: any): any {
    if (isObject(target) && isObject(source)) {
        for (const key in source) {
            if (isObject(source[key])) {
                if (!target[key]) Object.assign(target, { [key]: {} });
                mergeDeep(target[key], source[key]);
            } else {
                Object.assign(target, { [key]: source[key] });
            }
        }
    } else {
        return source;
    }
    return target;
}

function isBudgetTurnsExceeded(error: unknown): error is InvariantError {
    return error instanceof InvariantError && error.code === 'BUDGET_TURNS_EXCEEDED';
}

export function createTestHarness<
    Sensory = unknown,
    Obs = unknown,
    Alpha = unknown,
    ExecData = unknown,
    ExecError extends import('../loop/oneTurn.js').ExecErrorPayload = import('../loop/oneTurn.js').ExecErrorPayload
>(
    modules: Partial<Modules<Sensory, Obs, Alpha, ExecData, ExecError>>,
    config?: Partial<HarnessConfig>
): TestHarness<Sensory> {
    const configParsed = HarnessConfigSchema.parse(config || {});
    
    // Internal state
    const state: HarnessState<Sensory> = {
        m: {} as MentalState<Sensory>, // Filled below
        env: {
            time: new Date().toISOString(),
            sessionId: 'test-session',
            turn: 0,
            budget: { maxTurns: 100, latencyMs: 30000 },
            inbox: normalizeObservationInbox({ current: [], all: [] }),
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            control: undefined
        },
        inboxAll: [],
        traces: [],
        replies: [],
        errors: [],
        turnCount: 0,
        childDispatches: []
    };

    const llmStub = createDeterministicLLMStub();
    const toolStub = createDeterministicToolStub();

    const ctx = createTestContext(state, llmStub, toolStub);
    
    // Seed initial MentalState
    state.m = initialM(ctx) as MentalState<Sensory>;

    const harness: TestHarness<Sensory> = {
        seedMentalState(mOverride) {
            mergeDeep(state.m, mOverride);
            return harness;
        },
        seedPending(pendingOverride) {
            state.env.pending = mergeDeep(state.env.pending || {}, pendingOverride);
            return harness;
        },
        seedControlVars(vars) {
            const iCtx = ctx as InternalTaskContext;
            iCtx.controlVars = iCtx.controlVars ?? {};
            mergeDeep(iCtx.controlVars, vars);
            const pending = state.env.pending;
            pending.controlVars = pending.controlVars ?? {};
            mergeDeep(pending.controlVars, vars);
            return harness;
        },

        injectObservation(obs) {
            const raw = { inbox: { current: [obs], all: [obs] } } as unknown as { inbox: unknown };
            const normalized = normalizeObservationInbox(raw.inbox);
            if (normalized.current.some(o => o.kind === 'validation.failed')) {
                state.env.inbox.current.push(...normalized.current);
            } else {
                state.env.inbox.current.push(obs);
            }
            return harness;
        },
        injectUserInput(value) {
            return harness.injectObservation({
                source: 'user',
                kind: 'input.provided',
                payload: { token: 'test-input-tok', value }
            });
        },
        injectToolCompleted(params) {
            return harness.injectObservation({
                source: 'tool',
                kind: 'tool.completed',
                payload: { token: params.token, tool: params.tool, result: params.result || {} }
            });
        },
        injectToolFailed(params) {
            return harness.injectObservation({
                source: 'tool',
                kind: 'tool.failed',
                payload: { token: params.token, tool: params.tool, error: { code: 'E1', message: String(params.error) } }
            });
        },
        injectChildCompleted(params) {
            return harness.injectObservation({
                source: 'child',
                kind: 'child.completed',
                payload: { token: params.token, agentId: params.agentId, result: params.result || {} }
            });
        },
        injectChildFailed(params) {
            return harness.injectObservation({
                source: 'child',
                kind: 'child.failed',
                payload: { token: params.token, agentId: params.agentId, error: { code: 'E1', message: String(params.error) } }
            });
        },

        async runTurn() {
            state.errors.length = 0; // Clear errors locally for this turn
            
            const localCollector = new TurnTraceCollector();
            (ctx as InternalTaskContext).__turnTraceCollector = localCollector;

            try {
                const res = await runLoop(
                    ctx,
                    state.m,
                    state.env,
                    modules,
                    { maxTurns: 1, collectTraces: true }
                );
                
                state.m = res.M;

                if (process.env.CALLAGENT_DEBUG_HARNESS) {
                    const sensory = res.M.memory?.sensory;
                    const caseId =
                        sensory != null && typeof sensory === 'object' && 'caseId' in sensory
                            ? (sensory as { caseId?: unknown }).caseId
                            : undefined;
                    console.log(`[DEBUG_HARNESS] Turn ${state.turnCount} finished`, {
                        transition: res.outcome.kind,
                        stageAfter: localCollector.getLast()?.stageAfter,
                        hasSensory: sensory != null,
                        caseId,
                    });
                }
                const collected = localCollector.getAll();
                if (collected.length > 0) {
                    state.traces.push(...collected);
                } else if (res.outcome.kind === 'fail') {
                    // Synthesize a failed trace if loop failed before producing one
                    state.traces.push({
                        turn: state.turnCount + 1,
                        turnId: `test-turn-${state.turnCount + 1}`,
                        agentCardSource: 'inline',
                        runtimeManifestSource: 'inline',
                        agentCardHash: '',
                        runtimeManifestHash: '',
                        stageBefore: 'idle',
                        stageAfter: 'failed',
                        transition: { kind: 'fail', reason: res.outcome.reason },
                        inboxCurrent: [...state.env.inbox.current],
                        timings: { totalMs: 0 } as unknown as TurnTrace['timings'],
                    } as unknown as TurnTrace);
                }
                
                if (res.outcome.kind === 'fail' && 'error' in res.outcome && res.outcome.error) {
                    state.errors.push(res.outcome.error as Error);
                }
            } catch (err: unknown) {
                const collectedErr = localCollector.getAll();
                if (isBudgetTurnsExceeded(err) && collectedErr.length > 0) {
                    // state.m is already updated via the ctx.M setter (oneTurn sets iCtx.M = m1).
                    // Traces were collected before the budget throw; push them and continue.
                    state.traces.push(...collectedErr);
                    return harness;
                }
                state.errors.push(err instanceof Error ? err : new Error(String(err)));
                // Only synthesize if localCollector got nothing (e.g., threw before producing trace)
                if (collectedErr.length > 0) {
                    state.traces.push(...collectedErr);
                } else {
                    const turnId = `test-turn-${state.turnCount + 1}`;
                    state.traces.push({
                        turn: state.turnCount + 1,
                        turnId,
                        agentCardSource: 'inline',
                        runtimeManifestSource: 'inline',
                        agentCardHash: '',
                        runtimeManifestHash: '',
                        stageBefore: 'idle',
                        stageAfter: 'failed',
                        transition: { kind: 'fail', reason: 'harness_error' },
                        inboxCurrent: [...state.env.inbox.current],
                        timings: { totalMs: 0 } as unknown as TurnTrace['timings'],
                    } as unknown as TurnTrace);
                }
            } finally {
                state.turnCount++;
                const inboxSnapshot = [...state.env.inbox.current];
                state.inboxAll.push(...inboxSnapshot);
                // runLoop already places transition `continue` observations into env.inbox.current before
                // the local maxTurns budget throws. Clearing here would drop that feedback for the next
                // harness runTurn(); re-stage them when the trace shows continue.
                const lastTrace = localCollector.getLast();
                const keepContinueInbox =
                    lastTrace?.transition?.kind === 'continue' && inboxSnapshot.length > 0;
                state.env.inbox.current = keepContinueInbox ? inboxSnapshot : [];
                state.env.turn = (state.env.turn || 0) + 1;
            }

            return harness;
        },

        expectTurn(fn) {
            const trace = harness.lastTrace();
            const assertionCtx = createTurnAssertionContext(trace);
            fn(assertionCtx);
            return harness;
        },
        expectComplete() {
            const trace = harness.lastTrace();
            if (trace.transition?.kind !== 'complete') {
                throw new HarnessAssertionError('transition.kind', 'complete', trace.transition?.kind, trace.turn);
            }
            return harness;
        },
        expectFail() {
            const trace = harness.lastTrace();
            if (trace.transition?.kind !== 'fail') {
                throw new HarnessAssertionError('transition.kind', 'fail', trace.transition?.kind, trace.turn);
            }
            return harness;
        },
        expectInvariantError(fn) {
            const lastError = state.errors[state.errors.length - 1];
            if (!lastError || !(lastError instanceof InvariantError)) {
                throw new Error(`Expected an InvariantError but got ${lastError?.constructor.name || 'nothing'}`);
            }
            fn(lastError);
            return harness;
        },
        expectModuleError(fn) {
            const lastError = state.errors[state.errors.length - 1];
            if (!lastError || !(lastError instanceof ModuleExecutionError)) {
                throw new Error(`Expected a ModuleExecutionError but got ${lastError?.constructor.name || 'nothing'}`);
            }
            fn(lastError);
            return harness;
        },

        lastTrace() {
            if (state.traces.length === 0) {
                throw new Error('No traces available. Call runTurn() first.');
            }
            return state.traces[state.traces.length - 1];
        },
        lastAwaitToken() {
            const trace = harness.lastTrace();
            const token = trace.transition?.token;
            if (!token) {
                throw new Error(`No await token found in transition of kind '${trace.transition?.kind}'`);
            }
            return token;
        },
        allTraces() {
            return Object.freeze([...state.traces]);
        },
        currentM() {
            return Object.freeze({ ...state.m });
        },
        replies() {
            return Object.freeze([...state.replies]);
        },
        llmStub() {
            return llmStub;
        },
        toolStub() {
            return toolStub;
        }
    };

    return harness;
}
