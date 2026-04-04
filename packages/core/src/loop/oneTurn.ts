// One-turn scaffold: A → P → L → R → E with typed outcomes.
// This does not wire into the engine yet; it serves as the execution core
// that can be called by a handler wrapper or future loop driver.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from './types.js';
import type { Intent } from '../types/intent.js';
import type {
    Observation,
    ObservationProvenance,
    ExecErrorPayload
} from '../types/observation.js';
import type { StageTraceEntry } from '../types/stageFacade.js';
import { InvariantError, ModuleExecutionError, FrameworkModule } from '../utils/errors.js';
import { logger } from '@a2arium/callagent-utils';
import type { InternalTaskContext } from './internalContext.js';
import type {
    JsonValue,
    PerceptionTrace,
    IntentTrace,
    ShieldTrace,
    InboxObservationSummary,
} from '../types/turnTrace.js';
import { summarizeInbox } from '../telemetry/turnTraceHelpers.js';
import { computeStableHash } from '../telemetry/manifestProvenance.js';
import { compactModuleOutput } from '../telemetry/turnTraceHelpers.js';
import type { ExecResult, ExecOutcome } from '../types/execOutcome.js';

type MemoryWriterWithApply = MemoryWriter & {
    __applyToMental?: <S>(m: MentalState<S>) => MentalState<S>;
};

const log = logger.createLogger({ prefix: 'oneTurn' });

export type AttentionSignal = unknown;

export type { Observation, ObservationProvenance, ExecErrorPayload };
export type { ExecResult, ExecOutcome };

export type ShieldOutcome =
    | { action: 'pass'; intent: Intent }
    | { action: 'transform'; intent: Intent }
    | { action: 'veto'; reason: string }
    | { action: 'defer'; askUser: string };

export type TransitionOut =
    | { kind: 'continue'; observations: Observation[] }
    | { kind: 'await_input'; token: string }
    | { kind: 'await_child'; token: string }
    | { kind: 'await_tool'; token: string }
    | { kind: 'complete'; result?: unknown }
    | { kind: 'fail'; reason: string; error?: unknown };


// Temporary alias while downstream modules migrate
export type TurnOutcome = TransitionOut;

export type PolicyFn<Sensory = unknown, Obs = unknown> =
    | ((m: MentalState<Sensory>, mem: MemoryReader) => Intent | Array<{ action: Intent; prob: number }>)
    | ((m: MentalState<Sensory>, o: Obs, mem: MemoryReader) => Intent | Array<{ action: Intent; prob: number }>)
    | ((m: MentalState<Sensory>, prev: MentalState<Sensory> | undefined, o: Obs, mem: MemoryReader) => Intent | Array<{ action: Intent; prob: number }>);

export type Modules<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends ExecErrorPayload = ExecErrorPayload
> = {
    attention: (prev: MentalState<Sensory>, env: EnvironmentState, mem: MemoryReader) => Alpha;
    perception: (env: EnvironmentState, alpha: Alpha, mem: MemoryReader) => Obs | Promise<Obs>;
    learning: (
        prev: MentalState<Sensory>,
        prevAction: Intent | undefined,
        o: Obs,
        mem: MemoryReader,
        writer: MemoryWriter,
        rPrev?: number
    ) => MentalState<Sensory> | Promise<MentalState<Sensory>>;
    policy: (m: MentalState<Sensory>, mem: MemoryReader) => Intent | Array<{ action: Intent; prob: number }>;
    shield: (m: MentalState<Sensory>, a: Intent, mem: MemoryReader) => ShieldOutcome;
    execution: (a: Intent, ctx: TaskContext, mem: MemoryReader, m: MentalState<Sensory>) => Promise<ExecOutcome<ExecData, ExecError>>;
    transition: (
        env: EnvironmentState,
        exec: ExecOutcome<ExecData, ExecError>,
        m: MentalState<Sensory>,
        mem: MemoryReader
    ) => TransitionOut | Promise<TransitionOut>;
    extrinsicReward?: (m: MentalState<Sensory>, a: Intent, exec: ExecOutcome<ExecData, ExecError>, outcome: TransitionOut) => number;
    intrinsicReward?: (m: MentalState<Sensory>, o: Obs, mem: MemoryReader) => number;
};

export async function oneTurn<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends ExecErrorPayload = ExecErrorPayload
>(
    ctx: TaskContext,
    env: EnvironmentState,
    mPrev: MentalState<Sensory>,
    mods: Modules<Sensory, Obs, Alpha, ExecData, ExecError>,
    mem: MemoryReader,
    writer: MemoryWriter,
    prevAction?: Intent,
    rPrev?: number
): Promise<{
    m: MentalState<Sensory>;
    outcome: TransitionOut;
    exec: ExecOutcome<ExecData, ExecError>;
    timings: Record<string, number>;
    reward: number;
    stageTrace?: StageTraceEntry;
    attention?: JsonValue;
    perception?: PerceptionTrace;
    intent?: IntentTrace;
    shield?: ShieldTrace;
    inboxSnapshot?: InboxObservationSummary[];
    mentalStateBeforeHash?: string;
    mentalStateAfterHash?: string;
}> {
    const timings: Record<string, number> = {};
    const iCtx = ctx as InternalTaskContext;

    const runWithTiming = async <T>(
        name: string,
        fn: () => T | Promise<T>
    ): Promise<T> => Promise.resolve(fn());

    // Snapshot inbox before any module runs (compact summary for TurnTrace)
    const inboxCurrent = env.inbox?.current ?? [];
    const inboxSnapshot = summarizeInbox(
        Array.isArray(inboxCurrent) ? inboxCurrent : []
    );

    // MentalState hash before Learning (will be set after we have mPrev)
    let mentalStateBeforeHash: string | undefined;
    let mentalStateAfterHash: string | undefined;

    const tA0 = Date.now();
    let alpha: Alpha;
    try {
        alpha = await runWithTiming('attention', () => mods.attention(mPrev, env, mem));
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Attention, errorObj.message, errorObj);
    }
    timings.attentionMs = Date.now() - tA0;
    const attentionOut: JsonValue = compactModuleOutput(alpha);

    const tP0 = Date.now();
    let o: Obs;
    try {
        o = await runWithTiming('perception', () => mods.perception(env, alpha, mem));
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Perception, errorObj.message, errorObj);
    }
    timings.perceptionMs = Date.now() - tP0;
    const perceptionOut: PerceptionTrace = {
        kind: typeof o === 'object' && o !== null && 'kind' in (o as object) ? String((o as { kind?: string }).kind) : undefined,
        summary: undefined,
        data: compactModuleOutput(o),
    };

    mentalStateBeforeHash = computeStableHash(mPrev as Record<string, unknown>);

    const tL0 = Date.now();
    let m1: MentalState<Sensory>;
    try {
        const result = await runWithTiming('learning', () =>
            mods.learning(mPrev, prevAction, o, mem, writer, rPrev)
        );
        m1 = result instanceof Promise ? await result : result;
        const writerWithApply = writer as MemoryWriterWithApply;
        if (typeof writerWithApply?.__applyToMental === 'function') {
            m1 = writerWithApply.__applyToMental(m1);
        }
        mentalStateAfterHash = computeStableHash(m1 as Record<string, unknown>);
        log.debug('Learning returned MentalState', {
            hasScratch: !!(m1.memory?.scratch),
        });
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Learning, errorObj.message, errorObj);
    }
    timings.learningMs = Date.now() - tL0;

    // Expose current MentalState for this turn via ctx (read-mostly)
    try { iCtx.M = m1; } catch { /* noop */ }

    const tPol0 = Date.now();
    type PolicyResult = Intent | Array<{ action: Intent; prob: number }>;
    const policyFn = mods.policy;
    const arity = typeof policyFn === 'function' ? policyFn.length : 1;
    let pi: PolicyResult;
    try {
        if (arity >= 4) {
            pi = (policyFn as unknown as (m: MentalState<Sensory>, prev: MentalState<Sensory> | undefined, o: Obs, mem: MemoryReader) => PolicyResult)(m1, mPrev, o, mem);
        } else if (arity === 3) {
            pi = (policyFn as unknown as (m: MentalState<Sensory>, o: Obs, mem: MemoryReader) => PolicyResult)(m1, o, mem);
        } else {
            pi = (policyFn as unknown as (m: MentalState<Sensory>, mem: MemoryReader) => PolicyResult)(m1, mem);
        }
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Policy, errorObj.message, errorObj);
    }
    timings.policyMs = Date.now() - tPol0;

    // Store Policy Output (Intent) in local var for Shield Input
    const policyOutput = pi;

    // ... (omitted selection logic, assuming deterministic for telemetry correctness or updated later) ...
    // Note: The selection logic below modifies `chosen`, so we need to instrument Shield with the *selected* action.

    let chosen = Array.isArray(pi) ? pi[0].action : pi;
    if (Array.isArray(pi)) {
        const eps = m1.policyParams?.explorationEpsilon ?? 0;
        const temp = m1.policyParams?.temperature ?? 1;
        const stochastic = m1.policyParams?.stochastic ?? true;
        const probs = pi.map(p => Math.max(0, Number(p.prob) || 0));
        const weights = probs.map(p => (temp && temp > 0 && temp !== 1) ? Math.pow(p, 1 / temp) : p);
        if (!stochastic) {
            if (Math.random() < eps) {
                const idx = Math.floor(Math.random() * pi.length);
                chosen = pi[idx].action;
            } else {
                let maxIdx = 0; let maxVal = weights[0] ?? 0;
                for (let i = 1; i < weights.length; i++) {
                    if (weights[i] > maxVal) { maxVal = weights[i]; maxIdx = i; }
                }
                chosen = pi[maxIdx].action;
            }
        } else {
            if (Math.random() < eps) {
                const idx = Math.floor(Math.random() * pi.length);
                chosen = pi[idx].action;
            } else {
                const sum = weights.reduce((a, b) => a + b, 0) || 1;
                let t = Math.random() * sum;
                let selected = pi[0].action;
                for (let i = 0; i < weights.length; i++) {
                    t -= weights[i];
                    if (t <= 0) { selected = pi[i].action; break; }
                }
                chosen = selected;
            }
        }
    }
    const tSh0 = Date.now();
    let sh: ShieldOutcome;
    try {
        sh = await runWithTiming('shield', () => mods.shield(m1, chosen, mem));
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Shield, errorObj.message, errorObj);
    }
    timings.shieldMs = Date.now() - tSh0;
    const shieldOut: ShieldTrace = {
        action: sh.action,
        ...(sh.action === 'veto' && 'reason' in sh ? { reason: sh.reason } : {}),
        ...(sh.action === 'defer' && 'askUser' in sh ? { note: sh.askUser } : {}),
    };

    let toExecute: Intent | null = null;
    switch (sh.action) {
        case 'pass':
        case 'transform':
            toExecute = sh.intent;
            break;
        case 'veto':
            toExecute = { kind: 'internal', intent: 'vetoed' } as Intent;
            break;
        case 'defer':
            toExecute = { kind: 'prompt_user', prompt: sh.askUser } as Intent;
            break;
        default:
            toExecute = { kind: 'internal', intent: 'noop' } as Intent;
    }

    const tE0 = Date.now();
    if (iCtx.telemetry) {
        iCtx.__currentModule = 'execution';
    }
    let exec: ExecOutcome<ExecData, ExecError>;
    try {
        exec = await runWithTiming('execution', () =>
            mods.execution(toExecute!, ctx, mem, m1)
        );
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Execution, errorObj.message, errorObj);
    }
    timings.executionMs = Date.now() - tE0;
    if (iCtx.telemetry) {
        iCtx.__currentModule = undefined;
    }

    const tT0 = Date.now();
    let outcome: TransitionOut;
    try {
        outcome = await runWithTiming('transition', () =>
            mods.transition(env, exec, m1, mem)
        );
    } catch (error) {
        if (error instanceof InvariantError) throw error;
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ModuleExecutionError(FrameworkModule.Transition, errorObj.message, errorObj);
    }
    timings.transitionMs = Date.now() - tT0;

    // Reward hooks (pluggable; default to 0)
    let rExt = 0;
    if (typeof mods.extrinsicReward === 'function') {
        try {
            rExt = Number(mods.extrinsicReward(m1, chosen, exec, outcome) || 0);
        } catch (error) {
            log.error('ExtrinsicReward module error', { error: error instanceof Error ? error.message : String(error) });
            // Don't throw - reward is optional, just log and default to 0
        }
    }
    let rInt = 0;
    if (typeof mods.intrinsicReward === 'function') {
        try {
            rInt = Number(mods.intrinsicReward(m1, o, mem) || 0);
        } catch (error) {
            log.error('IntrinsicReward module error', { error: error instanceof Error ? error.message : String(error) });
            // Don't throw - reward is optional, just log and default to 0
        }
    }
    const r = (Number.isFinite(rExt) ? rExt : 0) + (Number.isFinite(rInt) ? rInt : 0);
    try {
        const episodic = m1.memory?.longTerm?.episodic ?? [];
        if (episodic.length > 0) {
            const last = episodic[episodic.length - 1] as EpisodicEventWithReward;
            last.rew = r;
        }
    } catch { /* noop */ }

    const stageTrace = iCtx.__stageTrace;
    if (iCtx.__stageTrace) {
        iCtx.__stageTrace = undefined;
    }

    type EpisodicEventWithReward = { t: number; obs: unknown; act: unknown; rew?: number; out?: unknown };

    const intentOut: IntentTrace = {
        kind: chosen.kind,
        summary: undefined,
        data: compactModuleOutput(chosen),
    };

    return {
        m: m1,
        exec,
        outcome,
        timings,
        reward: r,
        ...(stageTrace ? { stageTrace } : {}),
        attention: attentionOut,
        perception: perceptionOut,
        intent: intentOut,
        shield: shieldOut,
        inboxSnapshot,
        mentalStateBeforeHash,
        mentalStateAfterHash,
    };
}
