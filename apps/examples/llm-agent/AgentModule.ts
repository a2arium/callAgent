import { createAgent } from '@callagent/core';

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant.'
};

export default createAgent({
    manifest: {
        name: 'llm-agent',
        version: '0.1.0',
    },
    llmConfig,
    async handleTask(ctx) {
        const prompt = (ctx.task.input as any).prompt || 'Say hello!';
        // Call the LLM (assumes ctx.llm.call is available/configured)
        const llmResponse = await ctx.llm.call(prompt);
        await ctx.reply(typeof llmResponse === 'string' ? llmResponse : (llmResponse.content ?? JSON.stringify(llmResponse)));
        ctx.complete();
    },
}, import.meta.url); 