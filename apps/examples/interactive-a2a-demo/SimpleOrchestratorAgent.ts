import { createAgent, PluginManager } from '@a2arium/callagent-core';
import './ExtractorAgent.js';
import './AnalyzerAgent.js';

export default createAgent({
    manifest: { name: 'simple-orchestrator', version: '1.0.0' },
    async handleTask(ctx: any) {
        await ctx.reply([{ type: 'text', text: 'Simple Orchestrator: starting (blocking mode)' }]);

        const extract = await ctx.sendTaskToAgent('extractor', { source: 'db', limit: 5 });
        await ctx.reply([{ type: 'text', text: `Extracted rows=${(extract?.rows || []).length}` }]);

        const analysis = await ctx.sendTaskToAgent('analyzer', { method: 'basic', threshold: 60 });
        await ctx.reply([{ type: 'text', text: `Analyzer returned: ${JSON.stringify(analysis)}` }]);

        ctx.complete(100, 'completed');
        return { extract, analysis };
    }
}, import.meta.url);


