import { createAgent } from '@a2arium/callagent-core';

export default createAgent({
    async handleTask(ctx) {
        try {
            await ctx.reply('🤝 Hello-to-LLM Demo Starting...');

            ctx.progress(20, 'Calling hello-agent via A2A');

            // Call hello-agent via A2A with timeout and proper options
            const task: any = await ctx.sendTaskToAgent('hello-agent', {
                name: 'A2A Demo User'
            }, {
                timeout: 30000
            });
            const result = await task.run();

            ctx.progress(80, 'Hello-agent response received');

            await ctx.reply(['✅ Hello-agent Response received:', JSON.stringify(result, null, 2)]);

            ctx.complete(100, 'success');

            return { demoCompleted: true, helloResponse: result };

        } catch (error) {
            console.error('❌ Hello-to-LLM Demo error:', error);
            await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
            await ctx.fail(error);
            throw error;
        }
    }
}, import.meta.url); 