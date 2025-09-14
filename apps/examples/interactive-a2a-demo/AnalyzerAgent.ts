import { createAgent } from '@a2arium/callagent-core';
type Ctx = any;

export default createAgent({
    manifest: { name: 'analyzer', version: '1.0.0' },
    async handleTask(ctx: Ctx) {
        ctx.vars.debugString = 'Analyzer: ready';
        await ctx.reply([{ type: 'text', text: 'Analyzer: ready' }]);
        await ctx.requestInput('Provide threshold (0-100):', { onProvided: 'onThreshold' });
        return; // non-blocking path
    }
}, import.meta.url);

export async function onThreshold(ctx: Ctx, ev: { input: number }) {
    console.log('Analyzer: debugString', ctx.vars.debugString);
    const threshold = Number(ev.input) || 50;
    await ctx.reply([{ type: 'text', text: `Analyzer: threshold=${threshold}` }]);
    return { threshold };
}


