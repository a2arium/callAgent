import { createAgentPlugin } from '../../src/core/plugin/index.js';
import type { MessagePart, TaskContext } from '../../src/shared/types/index.js';

/**
 * Hello World agent that demonstrates a basic implementation.
 * 
 * This agent accepts a "name" parameter and responds with a greeting.
 */
export const helloAgent = createAgentPlugin({
    manifest: {
        name: 'hello-agent',
        version: '1.0.0',
    },
    handleTask: async (ctx: TaskContext) => {
        // Extract name from input, defaulting to "World"
        const name = ctx.task.input.name || 'World';

        // Log that we received a task
        ctx.logger.info(`Processing hello task for ${name}`);

        // Respond with a greeting
        const messageParts: MessagePart[] = [
            { type: 'text', text: `Hello, ${name}! I'm a simple agent.` }
        ];

        await ctx.reply(messageParts);

        // Mark the task as complete
        ctx.complete();
    }
}, import.meta.url); 