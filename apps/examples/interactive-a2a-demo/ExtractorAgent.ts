import { createAgent } from '@a2arium/callagent-core';

export default createAgent({
    manifest: { name: 'extractor', version: '1.0.0' },
    async handleTask(ctx) {
        await ctx.reply([{ type: 'text', text: 'Extractor: fetching data...' }]);
        // Simulate work
        ctx.complete(50, 'working');
        const rows = Array.from({ length: (ctx.task.input as any)?.limit || 5 }, (_, i) => ({ id: i + 1, value: Math.random() * 100 }));
        return { rows };
    }
}, import.meta.url);


