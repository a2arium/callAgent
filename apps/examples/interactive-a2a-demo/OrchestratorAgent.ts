import { createAgent } from '@a2arium/callagent-core';
// Using loose typing in example to accommodate runtime-augmented methods like requestInput/allTasks
type Ctx = any;

export default createAgent({
    manifest: { name: 'orchestrator', version: '1.0.0', dependencies: { agents: ['extractor', 'analyzer'] } },

    async handleTask(ctx: Ctx) {
        await ctx.reply([{ type: 'text', text: 'Orchestrator: starting flow' }]);
        ctx.vars.workflow = `wf_${Date.now()}`;

        // Request human input, durable
        await ctx.requestInput('Which region to analyze?', { onProvided: 'onRegionProvided', onExpired: 'onRegionExpired' });


        // Parallel example (optional):
        // await ctx.allTasks([
        //   { agent: 'extractor', input: { source: 'db', limit: 100 } },
        //   { agent: 'analyzer', input: { method: 'basic' } }
        // ], { onAllCompleted: 'onChildrenCompleted', onAnyFailed: 'onChildrenFailed' });

        return; // non-blocking
    }
}, import.meta.url);

export async function onRegionProvided(ctx: Ctx, ev: { input: string }) {
    ctx.vars.region = ev.input;

    console.log(`[Orchestrator] onRegionProvided ctx.tenantId=${ctx.tenantId} ctx.task.id=${ctx.task?.id}`);

    // Sequential flow
    const extract = await ctx.sendTaskToAgent('extractor', { source: 'db', limit: 100 });
    await ctx.sendTaskToAgent('analyzer', { method: 'basic' }, {
        onInputRequired: 'onAnalyzerInputRequired',
        onCompleted: 'onAnalyzerCompleted'
    });

    await ctx.reply([{ type: 'text', text: `Orchestrator: region=${ev.input}` }]);
}

export async function onRegionExpired(ctx: Ctx) {
    await ctx.reply([{ type: 'text', text: 'Orchestrator: input expired, defaulting to EU' }]);
    ctx.vars.region = 'EU';
}

export async function onChildrenCompleted(ctx: Ctx, ev: Record<string, unknown>) {
    await ctx.reply([{ type: 'text', text: 'Orchestrator: all children completed' }]);
    ctx.complete(100, 'completed');
}

export async function onChildrenFailed(ctx: Ctx, ev: Record<string, unknown>) {
    await ctx.reply([{ type: 'text', text: 'Orchestrator: a child failed' }]);
    await ctx.fail(new Error('child_failed'));
}

export async function onAnalyzerInputRequired(ctx: Ctx, ev: { input: { prompt: string; schema?: unknown; token: string; childTaskId?: string } }) {
    // In a full engine+RPC setup, you could now:
    // 1) Ask a human via ctx.requestInput('question', { onProvided: 'onAnalyzerInputProvided' })
    // 2) Or immediately provide a default answer by calling tasks/input (RPC) for the analyzer task using ev.token
    await ctx.reply([{ type: 'text', text: `Orchestrator received analyzer prompt: ${ev.input?.prompt}` }]);
    console.log('Orchestrator: onAnalyzerInputRequired', ev);
    // For demo, return the value; the framework will resume the child automatically
    return 60;
}

export async function onAnalyzerCompleted(ctx: Ctx, ev: { input: unknown }) {
    await ctx.reply([{ type: 'text', text: `Analyzer completed with: ${JSON.stringify(ev.input)}` }]);
    ctx.complete(100, 'completed');
}


