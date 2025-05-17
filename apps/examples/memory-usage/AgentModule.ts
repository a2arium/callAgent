import { createAgent } from '@callagent/core';

export default createAgent({
    manifest: {
        name: 'memory-usage',
        version: '0.1.0',
    },
    async handleTask(ctx) {
        // Set a value
        await ctx.memory.set('demo-key', { foo: 'bar', status: 'active' }, { tags: ['demo'] });
        // Get the value
        const value = await ctx.memory.get('demo-key');
        // Query by tag
        const results = await ctx.memory.query({ tag: 'demo' });
        // Query by filter
        const filtered = await ctx.memory.query({ filters: [{ path: 'status', operator: '=', value: 'active' }] });
        await ctx.reply([
            `Set value: ${JSON.stringify(value)}`,
            `Query by tag: ${JSON.stringify(results)}`,
            `Query by filter: ${JSON.stringify(filtered)}`
        ].join('\n'));
        ctx.complete();
    },
}, import.meta.url); 