import { createAgent, createStageFacade } from '@a2arium/callagent-core';
import type {
    EnvironmentState,
    MentalState,
    ExecutableAction,
    TurnOutcome,
    TaskContext,
    ProposedAction,
    ShieldOutcome,
    ExecResult,
    ObservationConfig,
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
        const latestInput = env.inbox.current.find(obs => obs.source === 'user' && obs.kind === 'input.provided');
        if (latestInput) {
            const payload = latestInput.payload as { value: { text: string } };
            const text = payload.value.text;
            console.log('[tg-agent] perception input', { text });
            return { text } as const;
        }
        return {} as const;
    },

    // L — Learning 
    learning: (prev: MentalState<Sensory>, _prevAction: ProposedAction | undefined, obs: Obs, _mem: import('@a2arium/callagent-core').MemoryReader, writer: import('@a2arium/callagent-core').MemoryWriter): MentalState<Sensory> => {
        const text = obs.text || undefined;
        const next = {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    current: text
                }
            }
        };
        // Example: record episodic event
        writer.episodic.append({ t: Date.now(), obs, act: _prevAction });
        return next;
    },

    // R — Policy (pure): map state to ProposedAction
    policy: (m: MentalState<Sensory>, _mem: import('@a2arium/callagent-core').MemoryReader): ProposedAction => {
        const currentInputText = m.memory.sensory.current?.trim();

        return currentInputText && currentInputText.length > 0
            ? ({ kind: 'internal', intent: 'answer_with_llm', data: { query: currentInputText } } as const)
            : ({ kind: 'ask_user', prompt: 'Please type your message' } as const);
    },

    // S — Shield: receives ProposedAction, returns ShieldOutcome
    shield: (_m: MentalState<Sensory>, a: ProposedAction, _mem: import('@a2arium/callagent-core').MemoryReader): ShieldOutcome =>
        ({ action: 'pass', intent: a } as const),

    // E — Execution: perform action by kind/intent (no policy decisions here)
    execution: async (a: ProposedAction, ctx: TaskContext, _mem: import('@a2arium/callagent-core').MemoryReader, _m: MentalState<Sensory>): Promise<{ action: ExecutableAction; result: ExecResult }> => {
        const baseResult = (): ExecResult => ({ status: 'ok', ts: Date.now(), toolId: 'telegram-bridge' });

        return await match(a)
            .with({ kind: 'ask_user' }, async (intent) => {
                await ctx.reply('How can I help you today?');
                const handle = await ctx.requestInput(intent.prompt, {
                    setStage: 'awaiting_input'
                });
                return {
                    action: { kind: 'ask_user', token: handle.token } as ExecutableAction,
                    result: { ...baseResult(), data: { prompt: intent.prompt }, correlationId: handle.token }
                };
            })
            .with({ kind: 'internal', intent: 'answer_with_llm', data: P.select('data') }, async ({ data }) => {
                const query = (data as { query?: string } | undefined)?.query ?? '';
                const res = await ctx.llm.call(query);
                await ctx.reply(`You said: ${query}`);
                await ctx.reply({ type: 'text', text: res[0]?.content ?? 'Ok.' });
                ctx.progress(100, 'completed');
                ctx.vars.set('completed.called', true);
                Stage.setStage(ctx, 'completed');
                return {
                    action: { kind: 'internal', done: true } as ExecutableAction,
                    result: { ...baseResult(), data: { ok: true, query, response: res[0]?.content ?? 'Ok.' } }
                };
            })
            .otherwise(async () => ({
                action: { kind: 'internal', done: true } as ExecutableAction,
                result: baseResult()
            }));
    },

    // T — Transition
    transition: (_env: EnvironmentState, exec: { action: ExecutableAction; result: ExecResult }, _m: MentalState<Sensory>): TurnOutcome<ObservationConfig> => {
        return match(exec.action)
            .with({ kind: 'ask_user' }, (action) => (
                { kind: 'await_input', token: action.token } as TurnOutcome<ObservationConfig>
            ))
            .with({ kind: 'internal', done: true }, () => (
                { kind: 'complete', result: exec.result.data ?? { ok: true } } as TurnOutcome<ObservationConfig>
            ))
            .otherwise(() => ({ kind: 'continue', observations: [] } as TurnOutcome<ObservationConfig>));
    }
}, import.meta.url);
