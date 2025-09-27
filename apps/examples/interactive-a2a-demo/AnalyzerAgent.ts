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
        // Demonstrate MentalState-backed vars and goals
        ctx.vars.set('debugString', 'Analyzer: ready');
        const goalId = await (ctx as any).addGoal({ title: 'Analyze threshold', type: 'short', priority: 1 });
        await ctx.llm.call('Hello, how are you?');
        const history = ctx.llm.getMessages();
        console.log('Analyzer: history', history);
        await ctx.reply([{ type: 'text', text: 'Analyzer: ready' }]);
        console.log('Analyzer: about to call requestInput...');
        await ctx.requestInput('Provide threshold (0-100):', { onProvided: 'onThreshold' });
        console.log('Analyzer: requestInput returned');
        return; // non-blocking path
    }
}, import.meta.url);

export async function onThreshold(ctx: Ctx, ev: { input: number }) {
    const history = ctx.llm.getMessages();
    console.log('Analyzer: history', history);
    console.log('Analyzer: onThreshold history', history);
    console.log('Analyzer: debugString', (ctx as any).vars.get('debugString'));
    const goals = await (ctx as any).listGoals();
    console.log('Analyzer: goals on resume', goals);
    const threshold = Number(ev.input) * 2 || 50;
    await ctx.reply([{ type: 'text', text: `Analyzer: threshold=${threshold}; vars.debugString=${(ctx as any).vars.get('debugString')}; goals=${goals?.length || 0}` }]);
    return { threshold };
}
