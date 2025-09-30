import { createAgent, isDirectInput } from '@a2arium/callagent-core';
import type { EnvironmentState, MentalState, ProposedAction, ExecutableAction, TurnOutcome, TaskContext } from '@a2arium/callagent-core';

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant. You reply heavily using markdown formatting.'
};

// Loop-first agent implementation
createAgent({
    manifest: 'agent.json',
    llmConfig,
    attention: () => null,
    perception: (env: EnvironmentState) => {
        try { console.info('[tg-agent] perception input', env?.input); } catch { }
        return env?.input;
    },
    learning: (prev: MentalState, _prevAction: ProposedAction | undefined, obs: unknown): MentalState => {
        const next = prev;
        try {
            if (isDirectInput(obs)) {
                const current = (next.memory.shortTerm.vars || {}) as Record<string, unknown>;
                const val = obs.value as unknown;
                const text = (typeof val === 'object' && val !== null) ? (val as { text?: unknown }).text ?? val : val;
                next.memory.shortTerm.vars = { ...current, userText: text } as Record<string, unknown>;
                try { console.info('[tg-agent] learning set userText', { text }); } catch { }
            }
        } catch { /* noop */ }

        return next;
    },
    policy: (m: MentalState): ProposedAction => {
        const v = (m.memory.shortTerm.vars || {}) as Record<string, unknown>;
        try { console.info('[tg-agent] policy vars', v); } catch { }
        // If we already have user input captured, respond immediately (avoids extra prompt)
        if (typeof v.userText !== 'undefined' && v.userText !== null && String(v.userText).length > 0) {
            return { kind: 'internal', intent: 'respond' } as ProposedAction;
        }
        if (!v.prompted) return { kind: 'internal', intent: 'prompt' } as ProposedAction;
        return { kind: 'ask_user', prompt: 'Please type your message' } as ProposedAction;
    },
    shield: (_m: MentalState, a: ProposedAction) => a,
    execution: async (a: ProposedAction, ctx: TaskContext, m: MentalState): Promise<ExecutableAction> => {
        const v = (m.memory.shortTerm.vars = (m.memory.shortTerm.vars || {}) as Record<string, unknown>);
        if (a?.kind === 'internal' && (a as any).intent === 'prompt') {
            await ctx.reply('What would you like me to remember?');
            v.prompted = true;
            return { kind: 'internal', done: true, intent: 'prompt' } as unknown as ExecutableAction;
        }
        if (a?.kind === 'ask_user') {
            try { console.info('[tg-agent] execution ask_user: requesting input'); } catch { }
            const handle = await ctx.requestInput((a as any).prompt as string, { onProvided: '__onUserAnswer' });
            try { console.info('[tg-agent] execution ask_user: token', { token: (handle as any)?.token }); } catch { }
            return { kind: 'ask_user', token: (handle as any)?.token || 'unknown' } as ExecutableAction;
        }
        if (a?.kind === 'internal' && (a as any).intent === 'respond') {
            const inputText = (v.userText as string | undefined) ?? ((ctx.task.input as any)?.text as string | undefined) ?? '';
            try { console.info('[tg-agent] execution respond: inputText', { inputText }); } catch { }
            if (inputText) {
                try { console.info('[tg-agent] reply #1: echo'); } catch { }
                await ctx.reply(`You said: ${inputText}`);
            }
            try {
                const res = await ctx.llm.call(inputText || '');
                try { console.info('[tg-agent] llm response', res); } catch { }
                const llmText = `${(res as any)?.[0]?.content ?? 'Ok.'}`;
                try { console.info('[tg-agent] reply #2: llm', { llmText }); } catch { }
                await ctx.reply({ type: 'text', text: llmText });
            } catch (e) {
                try { console.error('[tg-agent] llm error', e); } catch { }
                await ctx.reply('Ok.');
            }
            ctx.complete(100, 'completed');
            return { kind: 'internal', done: true, intent: 'respond' } as unknown as ExecutableAction;
        }
        return { kind: 'internal', done: true } as ExecutableAction;
    },
    transition: (_env: EnvironmentState, exec: ExecutableAction, _m: MentalState): TurnOutcome => {
        if ((exec as any)?.kind === 'ask_user') return { kind: 'await_input', token: (exec as any).token } as any;
        // Complete only after respond; keep prompting path open for requestInput to trigger input_required
        if ((exec as any)?.kind === 'internal' && (exec as any).intent === 'respond' && (exec as any).done === true) {
            return { kind: 'complete', result: { ok: true } } as any;
        }
        return { kind: 'continue' } as any;
    }
}, import.meta.url);
