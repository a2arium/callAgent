import { createAgent } from '@callagent/core';

export default createAgent({
    async handleTask(ctx) {
        // Set a value
        await ctx.memory.semantic.set('demo-key', { foo: 'bar', status: 'active' }, { tags: ['demo'] });
        // Get the value
        const value = await ctx.memory.semantic.get('demo-key');
        // Query by tag
        const results = await ctx.memory.semantic.query({ tag: 'demo' });
        // Query by filter
        const filtered = await ctx.memory.semantic.query({ filters: [{ path: 'status', operator: '=', value: 'active' }] });
        await ctx.reply([
            `Set value: ${JSON.stringify(value)}`,
            `Query by tag: ${JSON.stringify(results)}`,
            `Query by filter: ${JSON.stringify(filtered)}`
        ].join('\n'));
        ctx.complete();
    },
}, import.meta.url); 