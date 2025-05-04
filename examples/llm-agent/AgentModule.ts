import { createAgent } from '../../src/core/plugin/index.js';
import type { TaskContext } from '../../src/shared/types/index.js';
import type { LLMConfig } from '../../src/shared/types/LLMTypes.js';

// Define agent-specific LLM configuration
const llmAgentConfig: LLMConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are an AI assistant that provides concise, accurate responses.',
    historyMode: 'dynamic'
};

export default createAgent({
    llmConfig: llmAgentConfig,

    handleTask: async (ctx: TaskContext) => {
        ctx.logger.debug("Received task with input:", ctx.task.input);

        // Get the user query from input
        const query = typeof ctx.task.input.query === 'string'
            ? ctx.task.input.query
            : 'Tell me something interesting.';

        ctx.progress(20, 'Processing query: ' + query);

        try {
            ctx.logger.debug("Calling LLM with query:", query);

            const llmResponse = await ctx.llm.call(query);

            ctx.progress(50, 'Processing LLM response');
            ctx.logger.debug("Received LLM response", llmResponse.content);

            await ctx.reply(llmResponse.content || '');

            ctx.progress(60, 'Translating response to Russian');
            const translatedResponse = await ctx.llm.call(`Translate it to Russian`);
            ctx.logger.debug("Translated response", translatedResponse);

            await ctx.reply(translatedResponse.content || '');

            // Complete the task (usage will be added automatically by the framework)
            await ctx.complete(100, 'completed');
            ctx.logger.debug("Task completed successfully.");

        } catch (error) {
            ctx.throw('llm-agent-error', 'Failed to execute task', error);
        }
    }
}, import.meta.url);