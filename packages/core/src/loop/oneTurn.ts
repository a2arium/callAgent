// One-turn scaffold: A → P → L → R → E with typed outcomes.
// This does not wire into the engine yet; it serves as the execution core
// that can be called by a handler wrapper or future loop driver.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState } from './types.js';

export type AttentionSignal = unknown;
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

export type TurnOutcome =
    | { kind: 'continue' }
    | { kind: 'await_input'; token: string }
    | { kind: 'await_child'; token: string }
    | { kind: 'await_tool'; token: string }
    | { kind: 'complete'; result?: unknown }
    | { kind: 'fail'; reason: string };

export type Modules = {
    attention: (prev: MentalState, env: unknown) => AttentionSignal;
    perception: (env: unknown, alpha: AttentionSignal) => Observation;
    learning: (prev: MentalState, prevAction: ProposedAction | undefined, o: Observation, rPrev?: number) => MentalState;
    policy: (m: MentalState) => ProposedAction | Array<{ action: ProposedAction; prob: number }>;
    shield: (m: MentalState, a: ProposedAction) => ProposedAction | null;
};

export async function oneTurn(
    ctx: TaskContext,
    env: unknown,
    mPrev: MentalState,
    mods: Modules,
    prevAction?: ProposedAction,
    rPrev?: number
): Promise<{ m: MentalState; outcome: TurnOutcome; exec: ExecutableAction }> {
    const alpha = mods.attention(mPrev, env);
    const o = mods.perception(env, alpha);
    const m1 = mods.learning(mPrev, prevAction, o, rPrev);
    const pi = mods.policy(m1);
    const chosen = Array.isArray(pi) ? pi[0].action : pi;
    const safe = mods.shield(m1, chosen) ?? { kind: 'internal', intent: 'noop' };

    // Execution mapped to current engine context APIs
    if (safe.kind === 'ask_user') {
        const handle = await (ctx as any).requestInput(safe.prompt, { schema: safe.schema, onProvided: '__onInputProvided' });
        const token = (handle as any)?.token || '';
        return { m: m1, exec: { kind: 'ask_user', token }, outcome: { kind: 'await_input', token } };
    }
    if (safe.kind === 'subagent') {
        const res = await (ctx as any).sendTaskToAgent(safe.target, safe.input, { onCompleted: '__onChildCompleted' });
        const token = (res as any)?.token || (res as any)?.childToken;
        if (token) return { m: m1, exec: { kind: 'subagent', token }, outcome: { kind: 'await_child', token } };
        return { m: m1, exec: { kind: 'subagent', result: res }, outcome: { kind: 'continue' } };
    }
    if (safe.kind === 'tool') {
        const result = await (ctx as any).tools.invoke(safe.name, safe.args);
        return { m: m1, exec: { kind: 'tool', result }, outcome: { kind: 'continue' } };
    }
    if (safe.kind === 'language') {
        await ctx.reply(safe.content);
        return { m: m1, exec: { kind: 'language', echoed: true }, outcome: { kind: 'continue' } };
    }
    return { m: m1, exec: { kind: 'internal', done: true }, outcome: { kind: 'continue' } };
}


