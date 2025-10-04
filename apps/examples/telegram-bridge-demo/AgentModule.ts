import { createAgent, isDirectInput } from '@a2arium/callagent-core';
import type {
    EnvironmentState,
    MentalState,
    ExecutableAction,
    TurnOutcome,
    TaskContext,
    ProposedAction,
    ShieldOutcome,
} from '@a2arium/callagent-core';
import { match, P } from 'ts-pattern';

// === Minimal A-P-L-R-E-T aligned agent with ts-pattern ===

// 1) Stages (explicit control flow)
type Stage = 'idle' | 'awaiting_input' | 'completed';

type Observation = { text?: string };

// 2) Stage façade + invariants
const V = {
    stage: (ctx: TaskContext): Stage =>
        (ctx.vars.get('stage') as Stage) ?? 'idle',
    setStage: (ctx: TaskContext, s: Stage) => {
        if (s === 'awaiting_input' && !V.token(ctx)) {
            throw new Error('[invariant] awaiting_input requires token');
        }
        if (s === 'completed' && !V.completeCalled(ctx)) {
            throw new Error('[invariant] completed requires completeCalled');
        }
        ctx.vars.set('stage', s);
    },
    token: (ctx: TaskContext) => ctx.vars.get('token') as string | undefined,
    setToken: (ctx: TaskContext, t?: string) => ctx.vars.set('token', t),
    completeCalled: (ctx: TaskContext) => Boolean(ctx.vars.get('completeCalled')),
    setCompleteCalled: (ctx: TaskContext, v: boolean) => ctx.vars.set('completeCalled', v)
};

// 3) Intent mapping is embedded directly in policy

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant. You reply heavily using markdown formatting.'
};

createAgent({
    manifest: 'agent.json',
    llmConfig,

    // A — Attention
    attention: () => ({ wantPrompt: true }),

    // P — Perception (accept env, produce a small observation object)
    perception: (env: EnvironmentState) => {
        if (isDirectInput(env?.input)) {
            console.log('[tg-agent] perception input', env.input);
            const { text } = env.input.value as { text?: string };
            return { text } as const;
        }
        return {} as const;
    },

    // L — Learning 
    learning: (prev: MentalState, _prevAction: ProposedAction | undefined, obs: unknown): MentalState => {
        const o = obs as Partial<Observation>;
        const text = o.text || undefined;

        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    current: text
                }
            }
        };
    },

    // R — Policy (pure): map state to ProposedAction
    policy: (m: MentalState): ProposedAction => {
        const currentInputText =
            (m.memory?.sensory?.current as string | undefined);

        const trimmed = currentInputText?.trim();
        return trimmed && trimmed.length > 0
            ? ({ kind: 'internal', intent: 'answer_with_llm', data: { query: trimmed } } as const)
            : ({ kind: 'ask_user', prompt: 'Please type your message' } as const);
    },

    // S — Shield: receives ProposedAction, returns ShieldOutcome
    shield: (_m: MentalState, a: ProposedAction): ShieldOutcome =>
        ({ action: 'pass', intent: a } as const),

    // E — Execution: perform action by kind/intent (no policy decisions here)
    execution: async (a: ProposedAction, ctx: TaskContext, _m: MentalState): Promise<ExecutableAction> => {
        return await match(a)
            .with({ kind: 'ask_user' }, async (a) => {
                await ctx.reply('How can I help you today?');
                const handle = await ctx.requestInput(a.prompt, { onProvided: '__onUserAnswer' });
                const token = (handle as unknown as { token?: string }).token ?? 'unknown';
                V.setToken(ctx, token);
                V.setStage(ctx, 'awaiting_input');
                return { kind: 'ask_user', token } as const satisfies ExecutableAction;
            })
            .with({ kind: 'internal', intent: 'answer_with_llm', data: P.select('data') }, async ({ data }) => {
                const query = (data as { query?: string } | undefined)?.query ?? '';
                const res = await ctx.llm.call(query);
                await ctx.reply(`You said: ${query}`);
                await ctx.reply({ type: 'text', text: (res as Array<{ content?: string }>)[0]?.content ?? 'Ok.' });
                ctx.complete(100, 'completed');
                V.setCompleteCalled(ctx, true);
                V.setStage(ctx, 'completed');
                return { kind: 'internal', done: true } as const satisfies ExecutableAction;
            })
            .otherwise(async () => {
                return { kind: 'internal', done: true } as const satisfies ExecutableAction;
            });
    },

    // T — Transition
    transition: (_env: EnvironmentState, exec: ExecutableAction, _m: MentalState): TurnOutcome => {
        if (exec.kind === 'ask_user') {
            return { kind: 'await_input', token: exec.token } as const;
        }
        if (exec.kind === 'internal' && exec.done === true) {
            return { kind: 'complete', result: { ok: true } } as const;
        }
        return { kind: 'continue' } as const;
    }
}, import.meta.url);
