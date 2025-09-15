import { createAgent } from '@a2arium/callagent-core';
type Ctx = any;
const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant.',
    historyMode: 'dynamic' as const
};

export default createAgent({
    manifest: { name: 'analyzer', version: '1.0.0' },
    llmConfig,
    async handleTask(ctx: Ctx) {
        ctx.vars.debugString = 'Analyzer: ready';
        await ctx.llm.call('Hello, how are you?');
        const history = ctx.llm.getMessages();
        console.log('Analyzer: history', history);
        await ctx.reply([{ type: 'text', text: 'Analyzer: ready' }]);
        await ctx.requestInput('Provide threshold (0-100):', { onProvided: 'onThreshold' });
        return; // non-blocking path
    }
}, import.meta.url);

export async function onThreshold(ctx: Ctx, ev: { input: number }) {
    const history = ctx.llm.getMessages();
    console.log('Analyzer: history', history);
    console.log('Analyzer: onThreshold history', history);
    console.log('Analyzer: debugString', ctx.vars.debugString);
    const threshold = Number(ev.input) * 2 || 50;
    await ctx.reply([{ type: 'text', text: `Analyzer: threshold=${threshold}` }]);
    return { threshold };
}


