import { createAgentPlugin } from '../../src/core/plugin/index.js';
import type { TaskContext, MessagePart } from '../../src/shared/types/index.js';
import type { LLMConfig } from '../../src/shared/types/LLMTypes.js';

// Define agent-specific LLM configuration
const llmAgentConfig: LLMConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are an AI assistant that provides concise, accurate responses.',
};

export default createAgentPlugin({
    manifest: './agent.json',
    llmConfig: llmAgentConfig,

    handleTask: async (ctx: TaskContext) => {
        console.log("[llm-agent] Received task with input:", ctx.task.input);

        // Get the user query from input
        const query = typeof ctx.task.input.query === 'string'
            ? ctx.task.input.query
            : 'Tell me something interesting.';

        ctx.progress(20, 'Processing query: ' + query);

        try {
            console.log("[llm-agent] Calling LLM with query:", query);

            const llmResponse = await ctx.llm.call(query);

            ctx.progress(80, 'Processing LLM response');
            console.log("[llm-agent] Received LLM response:\n", llmResponse.content);

            // Prepare and send reply
            const responsePart: MessagePart = {
                type: 'text',
                text: llmResponse.content || 'No response content received'
            };
            await ctx.reply([responsePart]);

            // Include usage information if available
            if (llmResponse.metadata?.usage) {
                const usagePart: MessagePart = {
                    type: 'data',
                    data: { usage: llmResponse.metadata.usage }
                };
                await ctx.reply([usagePart]);
            }

            // Complete the task
            ctx.complete(100, 'completed');
            console.log("[llm-agent] Task completed successfully.");

        } catch (error) {
            await ctx.fail(error);
        }
    }
}, import.meta.url); 