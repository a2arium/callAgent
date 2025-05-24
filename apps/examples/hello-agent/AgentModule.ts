import { createAgent } from '@callagent/core';

export default createAgent({
    manifest: {
        name: 'hello-agent',
        version: '0.1.0'
    },
    async handleTask(ctx) {
        const name = (ctx.task.input as any).name || 'World';
        await ctx.reply(`Hello, ${name}!`);
        ctx.complete();
    },
}, import.meta.url); 