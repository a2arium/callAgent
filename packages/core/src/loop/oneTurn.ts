// One-turn scaffold: A → P → L → R → E with typed outcomes.
// This does not wire into the engine yet; it serves as the execution core
// that can be called by a handler wrapper or future loop driver.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState, EnvironmentState } from './types.js';

export type AttentionSignal = unknown;
// Keep Observation as alias for backward compatibility in this module.
export type Observation = unknown;

export type ProposedAction =
    | { kind: 'ask_user'; prompt: string; schema?: unknown }
    | { kind: 'subagent'; target: string; input: unknown; awaitCompletion?: boolean }
    | { kind: 'tool'; name: string; args: unknown; awaitCallback?: boolean }
    | { kind: 'language'; content: string }
    | { kind: 'internal'; intent: string; data?: unknown };

export type ExecutableAction =
    | { kind: 'ask_user'; token: string }
    | { kind: 'subagent'; token?: string; result?: unknown }
    | { kind: 'tool'; token?: string; result?: unknown }
    | { kind: 'language'; echoed: boolean }
    | { kind: 'internal'; done: boolean };

export type ShieldOutcome =
    | { action: 'pass'; intent: ProposedAction }
    | { action: 'transform'; intent: ProposedAction }
    | { action: 'veto'; reason: string }
    | { action: 'defer'; askUser: string };

export type TurnOutcome =
    | { kind: 'continue' }
    | { kind: 'await_input'; token: string }
    | { kind: 'await_child'; token: string }
    | { kind: 'await_tool'; token: string }
    | { kind: 'complete'; result?: unknown }
    | { kind: 'fail'; reason: string };

export type PolicyFn<Sensory = unknown, Obs = unknown> =
    | ((m: MentalState<Sensory>) => ProposedAction | Array<{ action: ProposedAction; prob: number }>)
    | ((m: MentalState<Sensory>, o: Obs) => ProposedAction | Array<{ action: ProposedAction; prob: number }>)
    | ((m: MentalState<Sensory>, prev: MentalState<Sensory> | undefined, o: Obs) => ProposedAction | Array<{ action: ProposedAction; prob: number }>);

export type Modules<Sensory = unknown, Obs = unknown> = {
    attention: (prev: MentalState<Sensory>, env: EnvironmentState) => AttentionSignal;
    perception: (env: EnvironmentState, alpha: AttentionSignal) => Obs;
    learning: (prev: MentalState<Sensory>, prevAction: ProposedAction | undefined, o: Obs, rPrev?: number) => MentalState<Sensory>;
    policy: PolicyFn<Sensory, Obs>;
    shield: (m: MentalState<Sensory>, a: ProposedAction) => ShieldOutcome;
    execution: (a: ProposedAction, ctx: TaskContext, m: MentalState<Sensory>) => Promise<ExecutableAction>;
    transition: (env: EnvironmentState, exec: ExecutableAction, m: MentalState<Sensory>) => TurnOutcome;
    extrinsicReward?: (m: MentalState<Sensory>, a: ProposedAction, exec: ExecutableAction, outcome: TurnOutcome) => number;
    intrinsicReward?: (m: MentalState<Sensory>, o: Obs) => number;
};

export async function oneTurn<Sensory = unknown, Obs = unknown>(
    ctx: TaskContext,
    env: EnvironmentState,
    mPrev: MentalState<Sensory>,
    mods: Modules<Sensory, Obs>,
    prevAction?: ProposedAction,
    rPrev?: number
): Promise<{ m: MentalState<Sensory>; outcome: TurnOutcome; exec: ExecutableAction; timings: Record<string, number>; reward: number }> {
    const timings: Record<string, number> = {};

    const tA0 = Date.now();
    const alpha = mods.attention(mPrev, env);
    timings.attentionMs = Date.now() - tA0;

    const tP0 = Date.now();
    const o = mods.perception(env, alpha);
    timings.perceptionMs = Date.now() - tP0;

    const tL0 = Date.now();
    const m1 = mods.learning(mPrev, prevAction, o, rPrev);
    timings.learningMs = Date.now() - tL0;

    // Expose current MentalState for this turn via ctx (read-mostly)
    try { (ctx as any).M = m1; } catch { /* noop */ }

    const tPol0 = Date.now();
    const policyFn = mods.policy as unknown as (...args: unknown[]) => ProposedAction | Array<{ action: ProposedAction; prob: number }>;
    const arity = typeof policyFn === 'function' ? policyFn.length : 1;
    const pi = (() => {
        try {
            if (arity >= 3) return (policyFn as any)(m1, mPrev, o);
            if (arity === 2) return (policyFn as any)(m1, o);
            return (policyFn as any)(m1);
        } catch {
            return (policyFn as any)(m1);
        }
    })();
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
    const sh = mods.shield(m1, chosen);
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
    const exec = await mods.execution(toExecute!, ctx, m1);
    timings.executionMs = Date.now() - tE0;

    const tT0 = Date.now();
    const outcome = mods.transition(env, exec, m1);
    timings.transitionMs = Date.now() - tT0;

    // Reward hooks (pluggable; default to 0)
    const rExt = typeof mods.extrinsicReward === 'function' ? Number(mods.extrinsicReward(m1, chosen, exec, outcome) || 0) : 0;
    const rInt = typeof mods.intrinsicReward === 'function' ? Number(mods.intrinsicReward(m1, o) || 0) : 0;
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


