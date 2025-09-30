import { createAgent } from '@a2arium/callagent-core';
import type { AnalyzerInput } from './types.js';
const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant.',
    historyMode: 'dynamic' as const
};

export default createAgent({
    manifest: { name: 'analyzer', version: '1.0.0', budgets: { maxTurns: 10 } },
    llmConfig,
    attention: () => null,
    perception: (env: any) => env?.input,
    learning: (prev: any, _prevAction: any, obs: unknown) => {
        const next: any = prev || {};
        try {
            const vars = (next.vars || {}) as Record<string, unknown>;
            // Capture input on resume
            if (obs && typeof obs === 'object' && (obs as any).kind === 'input') {
                (vars as any).thresholdInput = (obs as any).value;
            }
            next.vars = vars;
        } catch { /* noop */ }
        return next;
    },
    policy: (m: any) => {
        const v = (m?.vars || {}) as Record<string, unknown>;
        if (typeof v.thresholdInput === 'undefined') {
            console.log('[Analyzer] Policy: proposing ask_user because thresholdInput undefined');
            return { kind: 'ask_user', prompt: 'Provide threshold (0-100):' } as any;
        }
        console.log('[Analyzer] Policy: proposing internal finalize, thresholdInput =', v.thresholdInput);
        return { kind: 'internal', intent: 'finalize' } as any;
    },
    shield: (_m: any, a: any) => a,
    execution: async (a: any, ctx: any, m: any) => {
        console.log('[Analyzer] Execution: handling action kind =', a?.kind);
        if (a?.kind === 'ask_user') {
            console.log('[Analyzer] Execution: asking user');
            await ctx.reply([{ type: 'text', text: 'Analyzer: ready' }]);
            const tokenHandle = await (ctx as any).requestInput(a.prompt as string, {});
            return { kind: 'ask_user', token: (tokenHandle as any)?.token || 'unknown' } as any;
        }

        console.log('[Analyzer] Execution: finalizing');
        // finalize
        const v = (m?.vars || {}) as Record<string, unknown>;
        const raw = (v as any).thresholdInput;
        const threshold = Number(raw) * 2 || 50;
        await ctx.reply([{ type: 'text', text: `Analyzer: threshold=${threshold}` }]);
        (ctx.vars as any).set('analyzer.threshold', threshold);
        return { kind: 'internal', done: true } as any;
    },
    transition: (_env: any, exec: any) => {
        console.log('[Analyzer] Transition: exec.kind =', exec?.kind);
        if (exec?.kind === 'ask_user') {
            console.log('[Analyzer] Transition: returning await_input');
            return { kind: 'await_input', token: exec.token } as any;
        }
        console.log('[Analyzer] Transition: returning complete');
        return { kind: 'complete' } as any;
    }
}, import.meta.url);
