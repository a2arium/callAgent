import { createAgent, isDirectInput, createStageFacade } from '@a2arium/callagent-core';
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

// 2) Stage helpers (minimal, configurable)
const Stage = createStageFacade<Stage>({
    initial: 'idle',
    invariants: {
        awaiting_input: { require: ['token'], forbid: ['completed.called'] },
        completed: { require: ['completed.called'] }
    },
    autoMarks: {
        completed: { 'completed.called': true }
    }
});

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant. You reply heavily using markdown formatting.'
};

type Sensory = { current?: string };
type Obs = { text?: string };

createAgent<Sensory, Obs>({
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
    learning: (prev: MentalState<Sensory>, _prevAction: ProposedAction | undefined, obs: Obs): MentalState<Sensory> => {
        const text = obs.text || undefined;

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
    policy: (m: MentalState<Sensory>): ProposedAction => {
        const currentInputText = m.memory.sensory.current?.trim();

        return currentInputText && currentInputText.length > 0
            ? ({ kind: 'internal', intent: 'answer_with_llm', data: { query: currentInputText } } as const)
            : ({ kind: 'ask_user', prompt: 'Please type your message' } as const);
    },

    // S — Shield: receives ProposedAction, returns ShieldOutcome
    shield: (_m: MentalState<Sensory>, a: ProposedAction): ShieldOutcome =>
        ({ action: 'pass', intent: a } as const),

    // E — Execution: perform action by kind/intent (no policy decisions here)
    execution: async (a: ProposedAction, ctx: TaskContext, _m: MentalState<Sensory>): Promise<ExecutableAction> => {
        return await match(a)
            .with({ kind: 'ask_user' }, async (a) => {
                await ctx.reply('How can I help you today?');
                const handle = await ctx.requestInput(a.prompt);
                const token = (handle as unknown as { token?: string }).token ?? 'unknown';
                ctx.vars.set('token', token);
                Stage.setStage(ctx, 'awaiting_input');
                return { kind: 'ask_user', token } as ExecutableAction;
            })
            .with({ kind: 'internal', intent: 'answer_with_llm', data: P.select('data') }, async ({ data }) => {
                const query = (data as { query?: string } | undefined)?.query ?? '';
                const res = await ctx.llm.call(query);
                await ctx.reply(`You said: ${query}`);
                await ctx.reply({ type: 'text', text: res[0]?.content ?? 'Ok.' });
                ctx.progress(100, 'completed');
                Stage.setStage(ctx, 'completed');
                return { kind: 'internal', done: true } as ExecutableAction;
            })
            .otherwise(async () => {
                return { kind: 'internal', done: true } as ExecutableAction;
            });
    },

    // T — Transition
    transition: (_env: EnvironmentState, exec: ExecutableAction, _m: MentalState<Sensory>): TurnOutcome => {
        return match(exec)
            .with({ kind: 'ask_user' }, (e) => (
                { kind: 'await_input', token: e.token } as TurnOutcome
            ))
            .with({ kind: 'internal', done: true }, () => (
                { kind: 'complete', result: { ok: true } } as TurnOutcome
            ))
            .otherwise(() => ({ kind: 'continue' } as TurnOutcome));
    }
}, import.meta.url);
