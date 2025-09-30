import { createAgent, isChildCompletionInput } from '@a2arium/callagent-core';
import type { ExtractorInput, AnalyzerInput } from './types.js';

export default createAgent({
    manifest: { name: 'orchestrator', version: '1.0.0', budgets: { maxTurns: 10 }, dependencies: { agents: ['extractor', 'analyzer'] } },
    attention: () => null,
    perception: (env: any) => {
        console.log('[Orchestrator] perception TEST', env);
        try {
            const input = env?.input;
            if (input && (input as any).kind === 'child') {
                console.log('[Orchestrator] perception: child completed with result =', (input as any).result);
            }
        } catch { /* noop */ }
        return env;
    },
    learning: (prev: any, prevAction: any, obs: any) => {
        const next: any = prev || { vars: { done: false } };
        const v = (next.vars || {}) as Record<string, unknown>;
        if (typeof v.done === 'undefined') v.done = false;
        // Mark done after prior run
        try { if (prevAction && prevAction.kind === 'internal' && prevAction.intent === 'run') v.done = true; } catch { }
        // Handle child completion delivered as env.input
        try {
            const input = (obs as any)?.input;
            if (isChildCompletionInput(input)) {
                (v as any).analysis = input.result;
                (v as any).analysisOrigin = input.agentId || 'child';
                (v as any).analysisReady = true;
            }
        } catch { }
        // Detect child completion by env.pending/groups/children if surfaced (kept minimal)
        (next as any).vars = v;
        return next;
    },
    policy: (m: any) => {
        const v = (m?.vars || {}) as Record<string, unknown>;
        if ((v as any).analysisReady === true) {
            const msg = typeof v.analysis !== 'undefined'
                ? `Orchestrator: all done; analysis=${JSON.stringify(v.analysis)}`
                : 'Orchestrator: all done';
            return { kind: 'language', content: msg } as any;
        }
        if (!v.done) return { kind: 'internal', intent: 'run' } as any;
        const msg = typeof v.analysis !== 'undefined'
            ? `Orchestrator: all done; analysis=${JSON.stringify(v.analysis)}`
            : 'Orchestrator: all done';
        return { kind: 'language', content: msg } as any;
    },
    shield: (_m: any, a: any) => a,
    execution: async (a: any, ctx: any, m: any) => {
        const v = (m.vars = (m.vars || ({} as Record<string, unknown>)) as Record<string, unknown>);
        if (a?.kind === 'internal' && a.intent === 'run') {
            await ctx.reply([{ type: 'text', text: 'Orchestrator: starting flow' }]);
            ctx.vars.set('workflow', `wf_${Date.now()}`);
            const extract = await ctx.sendTaskToAgent?.('extractor', { source: 'db', limit: 100 } as ExtractorInput, { awaitCompletion: true });
            console.log('[Orchestrator] execution: extract =', extract);
            (v as any).extract = extract;
            await ctx.sendTaskToAgent?.('analyzer', { method: 'basic' } as AnalyzerInput, { awaitCompletion: false, onInputRequired: 'onAnalyzerAsk' });
            await ctx.reply([{ type: 'text', text: 'Orchestrator: dispatched analyzer (awaiting input)' }]);
            return { kind: 'internal', done: true } as any;
        }
        if (a?.kind === 'language') {
            // Extra confirmation that we received and processed analyzer output
            try {
                const v = (m.vars = (m.vars || ({} as Record<string, unknown>)) as Record<string, unknown>);
                if (typeof (v as any).analysis !== 'undefined') {
                    const origin = (v as any).analysisOrigin || 'child';
                    await ctx.reply([{ type: 'text', text: `Orchestrator: received ${origin} result = ${JSON.stringify((v as any).analysis)}` }]);
                }
            } catch { /* noop */ }
            await ctx.reply([{ type: 'text', text: a.content }]);
            ctx.complete(100, 'completed');
            return { kind: 'language', echoed: true } as any;
        }
        return { kind: 'internal', done: true } as any;
    },
    transition: (_env: any, exec: any) => {
        // Keep the parent task open until the child reports back
        if (exec?.kind === 'internal') return { kind: 'await_child' } as any;
        return { kind: 'complete' } as any;
    }
}, import.meta.url);


export async function onAnalyzerAsk(ctx: any, ev: { input: { prompt: string; schema?: unknown; token: string; childTaskId?: string } }) {
    console.log('[Orchestrator] onAnalyzerAsk', ev);
    await ctx.reply([{ type: 'text', text: `Parent: analyzer asked -> ${ev.input.prompt}` }]);
    // Provide a simple answer; in real usage, prompt the user or compute value
    return 60;
}
