import { createAgent, isDirectInput } from '@a2arium/callagent-core';
import type { EnvironmentState, MentalState, ExecutableAction, TurnOutcome, TaskContext, ProposedAction, ShieldOutcome } from '@a2arium/callagent-core';

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant. You reply heavily using markdown formatting.'
};

// === Minimal A-P-L-R-E-T aligned agent ===

// 1) Stages (explicit control flow)
type Stage = 'idle' | 'awaiting_input' | 'completed';

// 2) Intents (what Policy decides to do)
type Intent =
    | { kind: 'prompt_user' }
    | { kind: 'answer_with_llm'; query: string };

// 4) Typed façade for ctx.vars (+ minimal invariants)
const V = {
    stage: (ctx: TaskContext): Stage => (ctx.vars.get('stage') as Stage) ?? 'idle',
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

// Loop-first agent implementation (A-P-L-R-E-T modules)
createAgent({
    manifest: 'agent.json',
    llmConfig,
    // A - Attention
    attention: () => ({ wantPrompt: true }),

    // P - Perception → typed Observation
    perception: (env: EnvironmentState): unknown => {
        const inp = env?.input as unknown;
        if (isDirectInput(inp)) {
            const v = inp.value;
            const text = typeof v === 'string'
                ? v
                : (v && typeof v === 'object' && typeof (v as { text?: string }).text === 'string')
                    ? (v as { text?: string }).text
                    : undefined;
            return { text, resumeKind: 'input' } as { text?: string; resumeKind?: string };
        }
        if (inp && typeof inp === 'object' && typeof (inp as { text?: string }).text === 'string') {
            return { text: (inp as { text?: string }).text } as { text?: string };
        }
        return {};
    },

    // L - Learning (pure, immutable) → write cognition to M
    learning: (prev: MentalState, _prevAction: ProposedAction | undefined, obs: unknown): MentalState => {
        const o = (obs && typeof obs === 'object' ? obs as { text?: unknown; resumeKind?: unknown } : {}) as { text?: unknown; resumeKind?: unknown };
        const text = typeof o.text === 'string' ? o.text : undefined;
        const resumedFrom = o.resumeKind === 'input' ? 'input' : (undefined as string | undefined);
        const prevVars = (prev.memory?.shortTerm?.vars || {}) as Record<string, unknown>;
        return {
            ...prev,
            memory: {
                ...prev.memory,
                shortTerm: {
                    ...prev.memory.shortTerm,
                    vars: {
                        ...prevVars,
                        lastUserText: text ?? (prevVars.lastUserText as string | undefined),
                        resumedFrom: resumedFrom ?? (prevVars.resumedFrom as string | undefined)
                    }
                }
            }
        };
    },

    // R - Policy (pure) → Intent
    policy: (m: MentalState) => {
        const lastUserText = (m.vars?.lastUserText as string | undefined) || (m.memory?.shortTerm?.vars?.lastUserText as string | undefined);
        const t = typeof lastUserText === 'string' ? lastUserText.trim() : undefined;
        const intent: Intent = t ? { kind: 'answer_with_llm', query: t } : { kind: 'prompt_user' };
        // Map Intent → ProposedAction (engine contract)
        if (intent.kind === 'prompt_user') {
            return { kind: 'ask_user', prompt: 'Please type your message' } as ProposedAction;
        }
        return { kind: 'internal', intent: 'answer_with_llm', data: { query: intent.query } } as ProposedAction;
    },

    // S - Shield (align with current engine: pass-through)
    shield: (_m: MentalState, a: ProposedAction) => ({ action: 'pass', intent: a } as ShieldOutcome),

    // E - Execution (dispatcher by stage + intent)
    execution: async (a: ProposedAction, ctx: TaskContext, m: MentalState): Promise<ExecutableAction> => {
        const stage = V.stage(ctx);

        if (stage === 'idle' && a?.kind === 'ask_user') {
            await ctx.reply('How can I help you today?');
            const handle = await ctx.requestInput(a.prompt, { onProvided: '__onUserAnswer' });
            const token = (handle as unknown as { token?: string }).token || 'unknown';
            V.setToken(ctx, token);
            V.setStage(ctx, 'awaiting_input');
            return { kind: 'ask_user', token };
        }

        // If Policy chose to answer immediately but we're still idle, prompt first
        if (stage === 'idle' && a?.kind === 'internal' && (a as { intent: string }).intent === 'answer_with_llm') {
            const resumedFrom = (m.memory?.shortTerm?.vars?.resumedFrom as string | undefined) || (m.vars?.resumedFrom as string | undefined);
            if (resumedFrom === 'input') {
                const query = ((a as { data?: { query?: unknown } }).data?.query as string | undefined) || '';
                const res = await ctx.llm.call(query);
                await ctx.reply(`You said: ${query}`);
                await ctx.reply({ type: 'text', text: (res as Array<{ content?: string }>)[0]?.content ?? 'Ok.' });
                ctx.complete(100, 'completed');
                V.setCompleteCalled(ctx, true);
                V.setStage(ctx, 'completed');
                return { kind: 'internal', done: true };
            } else {
                await ctx.reply('How can I help you today?');
                const handle = await ctx.requestInput('Please type your message', { onProvided: '__onUserAnswer' });
                const token = (handle as unknown as { token?: string }).token || 'unknown';
                V.setToken(ctx, token);
                V.setStage(ctx, 'awaiting_input');
                return { kind: 'ask_user', token };
            }
        }

        if (stage === 'awaiting_input' && a?.kind === 'internal' && (a as { intent: string }).intent === 'answer_with_llm') {
            const query = ((a as { data?: { query?: unknown } }).data?.query as string | undefined) || '';
            const res = await ctx.llm.call(query);
            await ctx.reply(`You said: ${query}`);
            await ctx.reply({ type: 'text', text: (res as Array<{ content?: string }>)[0]?.content ?? 'Ok.' });
            ctx.complete(100, 'completed');
            V.setCompleteCalled(ctx, true);
            V.setStage(ctx, 'completed');
            return { kind: 'internal', done: true };
        }

        if (stage === 'completed') {
            return { kind: 'internal', done: true };
        }

        return { kind: 'internal', done: true };
    },

    // T - Transition (await and completion signals)
    transition: (_env: EnvironmentState, exec: ExecutableAction, _m: MentalState): TurnOutcome => {
        if (exec.kind === 'ask_user') {
            return { kind: 'await_input', token: (exec as { token: string }).token } as TurnOutcome;
        }
        if (exec.kind === 'internal' && exec.done === true) {
            return { kind: 'complete', result: { ok: true } } as TurnOutcome;
        }
        return { kind: 'continue' } as TurnOutcome;
    }
}, import.meta.url);
