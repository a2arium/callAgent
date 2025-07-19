import { createAgent } from '@callagent/core';

export default createAgent({
    async handleTask(ctx) {
        const input = ctx.task.input as any;
        const name = input.name || 'World';
        const timestamp = input.timestamp;
        const requestId = input.requestId;

        ctx.logger.info('🔄 Hello agent processing started', {
            name,
            timestamp,
            requestId,
            note: 'This agent has caching enabled with 30s TTL'
        });

        // Simulate some processing time to make cache benefits visible
        ctx.logger.info('⏳ Simulating processing delay...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const greeting = `Hello, ${name}! 👋`;
        const processedAt = new Date().toISOString();

        ctx.logger.info('✅ Processing completed', {
            greeting,
            processedAt,
            cacheNote: 'This result will be cached for 30 seconds'
        });

        await ctx.reply([{
            type: 'text',
            text: `${greeting}\n\nProcessed at: ${processedAt}\n\n💡 This response was generated with a 2-second delay. If you run the same request again within 30 seconds (with the same name but different timestamp/requestId), it should return instantly from cache!`
        }]);

        ctx.complete();

        return {
            greeting,
            processedAt,
            cacheStatus: 'miss' // This execution was not from cache
        };
    },
}, import.meta.url); 