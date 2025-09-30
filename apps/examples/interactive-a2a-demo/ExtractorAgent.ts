import { createAgent } from '@a2arium/callagent-core';
import type { ExtractorInput, ExtractorResult } from './types.js';

export default createAgent({
    manifest: { name: 'extractor', version: '1.0.0', budgets: { maxTurns: 10 } },
    attention: () => null,
    perception: (env: any) => env?.input,
    learning: (prev: any) => prev || {},
    policy: () => ({ kind: 'internal', intent: 'extract' } as any),
    shield: (_m: any, a: any) => a,
    execution: async (_a: any, ctx: any) => {
        await ctx.reply([{ type: 'text', text: 'Extractor: fetching data...' }]);
        ctx.complete(50, 'working');
        const input = ctx.task.input as ExtractorInput;
        const rows: ExtractorResult = Array.from({ length: input?.limit || 5 }, (_, i) => ({ id: i + 1, value: Math.random() * 100 }));
        ctx.vars.set('extract.rowsCount', rows.length);
        await ctx.reply([{ type: 'text', text: `Extractor: rows=${rows.length}` }]);
        // Return rows via the executable action so transition can complete with a result
        return { kind: 'internal', result: rows } as any;
    },
    transition: (_env: any, exec: any) => ({ kind: 'complete', result: (exec as any)?.result } as any)
}, import.meta.url);


