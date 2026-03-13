// One-turn scaffold: A → P → L → R → E with typed outcomes.
// This does not wire into the engine yet; it serves as the execution core
// that can be called by a handler wrapper or future loop driver.

import type { TaskContext } from '../../../shared/types/index.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from './types.js';
import type { Intent, ExecutableAction } from '../intent.js';
import { z } from 'zod';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'oneTurn' });

export type AttentionSignal = unknown;

export type ObservationProvenance = {
    ts: number;
    turn: number;
    id?: string;
    toolId?: string;
    correlationId?: string;
};

export type ObservationConfig = {
    user?: unknown;
    tool?: unknown;
    child?: unknown;
    internal?: unknown;
    env?: unknown;
};

export type UserEnvelope<T> = { token: string; value: T };
export type ToolEnvelope<T> = { token: string; result: T; tool: string };
export type ChildEnvelope<T> = {
    token: string;
    result: T;
    agentId?: string;
    childTaskId?: string;
    executionMetadata?: {
        timings?: unknown;
        rewards?: unknown;
        state?: string;
        timestamp?: string;
    };
};

export type SynthesizeObservation<T extends ObservationConfig> =
    | (T['user'] extends undefined ? never : { source: 'user'; kind: 'input.provided'; payload: UserEnvelope<T['user']>; provenance?: ObservationProvenance; error?: { code: string; message: string } })
    | (T['tool'] extends undefined ? never : { source: 'tool'; kind: 'tool.completed'; payload: ToolEnvelope<T['tool']>; provenance?: ObservationProvenance; error?: { code: string; message: string } })
    | (T['child'] extends undefined ? never : { source: 'child'; kind: 'child.completed'; payload: ChildEnvelope<T['child']>; provenance?: ObservationProvenance; error?: { code: string; message: string } })
    | (T['internal'] extends undefined ? never : { source: 'internal'; kind: string; payload: T['internal']; provenance?: ObservationProvenance; error?: { code: string; message: string } })
    | (T['env'] extends undefined ? never : { source: 'env'; kind: string; payload: T['env']; provenance?: ObservationProvenance; error?: { code: string; message: string } });

export type Observation<Payload = unknown> = {
    source: 'tool' | 'child' | 'env' | 'user' | 'internal';
    kind: string;
    payload: Payload;
    provenance?: ObservationProvenance;
    error?: { code: string; message: string };
};

export type ExecErrorPayload = { code: string; message: string };


export const ObservationSchema = z.object({
    source: z.enum(['user', 'tool', 'child', 'internal', 'env']),
    kind: z.string(),
    payload: z.unknown(),
    provenance: z.object({
        ts: z.number(),
        turn: z.number(),
        id: z.string().optional(),
        toolId: z.string().optional(),
        correlationId: z.string().optional()
    }).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional()
});

export type ExecResult<Data = unknown, ErrorPayload extends ExecErrorPayload = ExecErrorPayload> = {
    status: 'ok' | 'error';
    data?: Data;
    error?: ErrorPayload;
    receipts?: unknown;
    correlationId?: string;
    toolId?: string;
    ts?: number;
};

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
    | { kind: 'fail'; reason: string };

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
    execution: (a: Intent, ctx: TaskContext, mem: MemoryReader, m: MentalState<Sensory>) => Promise<{ action: ExecutableAction; result: ExecResult<ExecData, ExecError> }>;
    transition: (
        env: EnvironmentState,
        exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> },
        m: MentalState<Sensory>,
        mem: MemoryReader
    ) => TransitionOut | Promise<TransitionOut>;
    extrinsicReward?: (m: MentalState<Sensory>, a: Intent, exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> }, outcome: TransitionOut) => number;
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
    exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> };
    timings: Record<string, number>;
    reward: number;
}> {
    const timings: Record<string, number> = {};

    const tA0 = Date.now();
    let alpha: Alpha;
    try {
        alpha = mods.attention(mPrev, env, mem);
    } catch (error) {
        log.error('Attention module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Attention module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.attentionMs = Date.now() - tA0;

    const tP0 = Date.now();
    let o: Obs;
    try {
        o = await Promise.resolve(mods.perception(env, alpha, mem));
    } catch (error) {
        log.error('Perception module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Perception module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.perceptionMs = Date.now() - tP0;

    const tL0 = Date.now();
    let m1: MentalState<Sensory>;
    try {
        const result = mods.learning(mPrev, prevAction, o, mem, writer, rPrev);
        m1 = result instanceof Promise ? await result : result;
        // Apply in-memory patches (if writer exposes an apply hook) so Policy sees updates
        const applyFn = (writer as any)?.__applyToMental;
        if (typeof applyFn === 'function') {
            m1 = applyFn(m1);
        }
        log.debug('Learning returned MentalState', { hasScratch: !!((m1 as any).memory?.scratch) });
    } catch (error) {
        log.error('Learning module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Learning module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.learningMs = Date.now() - tL0;

    // Expose current MentalState for this turn via ctx (read-mostly)
    try { (ctx as any).M = m1; } catch { /* noop */ }

    const tPol0 = Date.now();
    const policyFn = mods.policy as unknown as (...args: unknown[]) => Intent | Array<{ action: Intent; prob: number }>;
    const arity = typeof policyFn === 'function' ? policyFn.length : 1;
    let pi: Intent | Array<{ action: Intent; prob: number }>;
    try {
        if (arity >= 3) { // Original arity checks included llm, now adjusted
            pi = (policyFn as any)(m1, mPrev, o, mem);
        } else if (arity === 2) {
            pi = (policyFn as any)(m1, o, mem);
        } else {
            pi = (policyFn as any)(m1, mem);
        }
    } catch (error) {
        log.error('Policy module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Policy module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.policyMs = Date.now() - tPol0;
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
    let sh: ShieldOutcome;
    try {
        sh = mods.shield(m1, chosen, mem);
    } catch (error) {
        log.error('Shield module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Shield module failed: ${error instanceof Error ? error.message : String(error)}`);
    }

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
    let exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> };
    try {
        exec = await mods.execution(toExecute!, ctx, mem, m1);
    } catch (error) {
        log.error('Execution module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Execution module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.executionMs = Date.now() - tE0;

    const tT0 = Date.now();
    let outcome: TransitionOut;
    try {
        outcome = await Promise.resolve(mods.transition(env, exec, m1, mem));
    } catch (error) {
        log.error('Transition module error', { error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Transition module failed: ${error instanceof Error ? error.message : String(error)}`);
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
        // Append reward to last episodic event (if any)
        const episodic = (m1.memory.longTerm.episodic || []);
        if (episodic.length > 0) {
            const last = episodic[episodic.length - 1] as any;
            last.rew = r;
        }
    } catch { /* noop */ }

    return { m: m1, exec, outcome, timings, reward: r };
}
