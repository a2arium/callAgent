import { createAgent } from '@callagent/core';

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant.'
};

export default createAgent({
    llmConfig,
    async handleTask(ctx) {
        const prompt = (ctx.task.input as any).prompt || 'Say hello!';

        // Show progress steps with percentages
        ctx.progress(10, 'Analyzing your request...');

        // Simulate some processing time
        await new Promise(resolve => setTimeout(resolve, 1000));

        ctx.progress(30, 'Preparing LLM call...');

        await new Promise(resolve => setTimeout(resolve, 500));

        ctx.progress({
            state: 'working',
            timestamp: new Date().toISOString(),
            message: {
                role: 'agent',
                parts: [{ type: 'text', text: 'Calling LLM...' }]
            }
        });

        // Call the LLM (assumes ctx.llm.call is available/configured)
        const llmResponses = await ctx.llm.call(prompt);

        ctx.progress(80, 'Processing response...');

        await new Promise(resolve => setTimeout(resolve, 300));

        ctx.progress(95, 'Formatting output...');

        // Handle multiple responses from the LLM
        if (llmResponses.length === 1) {
            // Single response - handle as before for backward compatibility
            const response = llmResponses[0];
            await ctx.reply(typeof response === 'string' ? response : (response.content ?? JSON.stringify(response)));
        } else {
            // Multiple responses - combine them or handle individually
            const combinedContent = llmResponses
                .map((response: any, index: number) => {
                    const content = typeof response === 'string' ? response : (response.content ?? JSON.stringify(response));
                    return llmResponses.length > 1 ? `Response ${index + 1}: ${content}` : content;
                })
                .join('\n\n');
            await ctx.reply(combinedContent);
        }

        ctx.complete();
    },
}, import.meta.url); 