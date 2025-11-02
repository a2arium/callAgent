// One-turn scaffold: A → P → L → R → E with typed outcomes.
// This does not wire into the engine yet; it serves as the execution core
// that can be called by a handler wrapper or future loop driver.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState, EnvironmentState } from './types.js';
import type { PureLLMPort } from '../shared/types/LLMTypes.js';

export type AttentionSignal = unknown;

export type ObservationProvenance = {
    ts: number;
    turn: number;
    id?: string;
    toolId?: string;
    correlationId?: string;
};

export type Observation = {
    source: 'tool' | 'child' | 'env' | 'user' | 'internal';
    kind: string;
    payload: unknown;
    provenance: ObservationProvenance;
    error?: { code: string; message: string };
};

export type ProposedAction =
    | { kind: 'ask_user'; prompt: string; schema?: unknown }
    | { kind: 'subagent'; target: string; input: unknown; awaitCompletion?: boolean }
    | { kind: 'tool'; name: string; args: unknown; awaitCallback?: boolean }
    | { kind: 'language'; content: string }
    | { kind: 'internal'; intent: string; data?: unknown };

export type ExecutableAction =
    | { kind: 'ask_user'; token: string }
    | { kind: 'subagent'; token?: string }
    | { kind: 'tool'; token?: string }
    | { kind: 'language'; echoed: boolean }
    | { kind: 'internal'; done: boolean };

export type ExecErrorPayload = { code: string; message: string };

export type ExecResult<Data = unknown, ErrorPayload = ExecErrorPayload> = {
    status: 'ok' | 'error';
    data?: Data;
    error?: ErrorPayload;
    receipts?: unknown;
    correlationId?: string;
    toolId?: string;
    ts?: number;
};

export type ShieldOutcome =
    | { action: 'pass'; intent: ProposedAction }
    | { action: 'transform'; intent: ProposedAction }
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
    | ((m: MentalState<Sensory>, llm?: PureLLMPort) => ProposedAction | Array<{ action: ProposedAction; prob: number }>)
    | ((m: MentalState<Sensory>, o: Obs, llm?: PureLLMPort) => ProposedAction | Array<{ action: ProposedAction; prob: number }>)
    | ((m: MentalState<Sensory>, prev: MentalState<Sensory> | undefined, o: Obs, llm?: PureLLMPort) => ProposedAction | Array<{ action: ProposedAction; prob: number }>);

export type Modules<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError = ExecErrorPayload
> = {
    attention: (prev: MentalState<Sensory>, env: EnvironmentState, llm?: PureLLMPort) => Alpha;
    perception: (env: EnvironmentState, alpha: Alpha, llm?: PureLLMPort) => Obs | Promise<Obs>;
    learning: (prev: MentalState<Sensory>, prevAction: ProposedAction | undefined, o: Obs, rPrev?: number, llm?: PureLLMPort) => MentalState<Sensory>;
    policy: PolicyFn<Sensory, Obs>;
    shield: (m: MentalState<Sensory>, a: ProposedAction, llm?: PureLLMPort) => ShieldOutcome;
    execution: (a: ProposedAction, ctx: TaskContext, m: MentalState<Sensory>) => Promise<{ action: ExecutableAction; result: ExecResult<ExecData, ExecError> }>;
    transition: (env: EnvironmentState, exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> }, m: MentalState<Sensory>, llm?: PureLLMPort) => TransitionOut | Promise<TransitionOut>;
    extrinsicReward?: (m: MentalState<Sensory>, a: ProposedAction, exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> }, outcome: TransitionOut, llm?: PureLLMPort) => number;
    intrinsicReward?: (m: MentalState<Sensory>, o: Obs, llm?: PureLLMPort) => number;
};

export async function oneTurn<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError = ExecErrorPayload
>(
    ctx: TaskContext,
    env: EnvironmentState,
    mPrev: MentalState<Sensory>,
    mods: Modules<Sensory, Obs, Alpha, ExecData, ExecError>,
    prevAction?: ProposedAction,
    rPrev?: number
): Promise<{
    m: MentalState<Sensory>;
    outcome: TransitionOut;
    exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> };
    timings: Record<string, number>;
    reward: number;
}> {
    const timings: Record<string, number> = {};

    // Extract pure LLM port for use in pure modules
    const { extractPureLLMPort } = await import('../shared/types/LLMTypes.js');
    const llm = ctx.llm ? extractPureLLMPort(ctx) : undefined;

    const tA0 = Date.now();
    let alpha: Alpha;
    try {
        alpha = mods.attention(mPrev, env, llm);
    } catch (error) {
        console.error('[oneTurn] Attention module error:', error);
        throw new Error(`Attention module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.attentionMs = Date.now() - tA0;

    const tP0 = Date.now();
    let o: Obs;
    try {
        o = await Promise.resolve(mods.perception(env, alpha, llm));
    } catch (error) {
        console.error('[oneTurn] Perception module error:', error);
        throw new Error(`Perception module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.perceptionMs = Date.now() - tP0;

    const tL0 = Date.now();
    let m1: MentalState<Sensory>;
    try {
        m1 = mods.learning(mPrev, prevAction, o, rPrev, llm);
    } catch (error) {
        console.error('[oneTurn] Learning module error:', error);
        throw new Error(`Learning module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.learningMs = Date.now() - tL0;

    // Expose current MentalState for this turn via ctx (read-mostly)
    try { (ctx as any).M = m1; } catch { /* noop */ }

    const tPol0 = Date.now();
    const policyFn = mods.policy as unknown as (...args: unknown[]) => ProposedAction | Array<{ action: ProposedAction; prob: number }>;
    const arity = typeof policyFn === 'function' ? policyFn.length : 1;
    let pi: ProposedAction | Array<{ action: ProposedAction; prob: number }>;
    try {
        if (arity >= 4) {
            pi = (policyFn as any)(m1, mPrev, o, llm);
        } else if (arity === 3) {
            pi = (policyFn as any)(m1, o, llm);
        } else if (arity === 2) {
            pi = (policyFn as any)(m1, llm);
        } else {
            pi = (policyFn as any)(m1);
        }
    } catch (error) {
        console.error('[oneTurn] Policy module error:', error);
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
        sh = mods.shield(m1, chosen, llm);
    } catch (error) {
        console.error('[oneTurn] Shield module error:', error);
        throw new Error(`Shield module failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let toExecute: ProposedAction | null = null;
    switch (sh.action) {
        case 'pass':
        case 'transform':
            toExecute = sh.intent;
            break;
        case 'veto':
            toExecute = { kind: 'internal', intent: 'vetoed' } as ProposedAction;
            break;
        case 'defer':
            toExecute = { kind: 'ask_user', prompt: sh.askUser } as ProposedAction;
            break;
        default:
            toExecute = { kind: 'internal', intent: 'noop' } as ProposedAction;
    }

    const tE0 = Date.now();
    let exec: { action: ExecutableAction; result: ExecResult<ExecData, ExecError> };
    try {
        exec = await mods.execution(toExecute!, ctx, m1);
    } catch (error) {
        console.error('[oneTurn] Execution module error:', error);
        throw new Error(`Execution module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.executionMs = Date.now() - tE0;

    const tT0 = Date.now();
    let outcome: TransitionOut;
    try {
        outcome = await Promise.resolve(mods.transition(env, exec, m1, llm));
    } catch (error) {
        console.error('[oneTurn] Transition module error:', error);
        throw new Error(`Transition module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    timings.transitionMs = Date.now() - tT0;

    // Reward hooks (pluggable; default to 0)
    let rExt = 0;
    if (typeof mods.extrinsicReward === 'function') {
        try {
            rExt = Number(mods.extrinsicReward(m1, chosen, exec, outcome, llm) || 0);
        } catch (error) {
            console.error('[oneTurn] ExtrinsicReward module error:', error);
            // Don't throw - reward is optional, just log and default to 0
        }
    }
    let rInt = 0;
    if (typeof mods.intrinsicReward === 'function') {
        try {
            rInt = Number(mods.intrinsicReward(m1, o, llm) || 0);
        } catch (error) {
            console.error('[oneTurn] IntrinsicReward module error:', error);
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


