import type { TaskContext } from '../shared/types/index.js';
import type { MentalState, EnvironmentState } from './types.js';
export type AttentionSignal = unknown;
export type Observation = unknown;
export type ProposedAction = {
    kind: 'ask_user';
    prompt: string;
    schema?: unknown;
} | {
    kind: 'subagent';
    target: string;
    input: unknown;
    awaitCompletion?: boolean;
} | {
    kind: 'tool';
    name: string;
    args: unknown;
    awaitCallback?: boolean;
} | {
    kind: 'language';
    content: string;
} | {
    kind: 'internal';
    intent: string;
    data?: unknown;
};
export type ExecutableAction = {
    kind: 'ask_user';
    token: string;
} | {
    kind: 'subagent';
    token?: string;
    result?: unknown;
} | {
    kind: 'tool';
    token?: string;
    result?: unknown;
} | {
    kind: 'language';
    echoed: boolean;
} | {
    kind: 'internal';
    done: boolean;
};
export type ShieldOutcome = {
    action: 'pass';
    intent: ProposedAction;
} | {
    action: 'transform';
    intent: ProposedAction;
} | {
    action: 'veto';
    reason: string;
} | {
    action: 'defer';
    askUser: string;
};
export type TurnOutcome = {
    kind: 'continue';
} | {
    kind: 'await_input';
    token: string;
} | {
    kind: 'await_child';
    token: string;
} | {
    kind: 'await_tool';
    token: string;
} | {
    kind: 'complete';
    result?: unknown;
} | {
    kind: 'fail';
    reason: string;
};
export type PolicyFn<Sensory = unknown, Obs = unknown> = ((m: MentalState<Sensory>) => ProposedAction | Array<{
    action: ProposedAction;
    prob: number;
}>) | ((m: MentalState<Sensory>, o: Obs) => ProposedAction | Array<{
    action: ProposedAction;
    prob: number;
}>) | ((m: MentalState<Sensory>, prev: MentalState<Sensory> | undefined, o: Obs) => ProposedAction | Array<{
    action: ProposedAction;
    prob: number;
}>);
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
export declare function oneTurn<Sensory = unknown, Obs = unknown>(ctx: TaskContext, env: EnvironmentState, mPrev: MentalState<Sensory>, mods: Modules<Sensory, Obs>, prevAction?: ProposedAction, rPrev?: number): Promise<{
    m: MentalState<Sensory>;
    outcome: TurnOutcome;
    exec: ExecutableAction;
    timings: Record<string, number>;
    reward: number;
}>;
