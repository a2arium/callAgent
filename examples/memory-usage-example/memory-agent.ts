import { createAgent } from '../../src/core/plugin/index.js';
import type { TaskContext } from '../../src/shared/types/index.js';
import type { MemoryQueryResult } from '../../src/core/memory/IMemory.js';

// Define a type for our fact data
type FactData = {
    fact: string;
    value: string;
};


/**
 * Simple Memory Agent
 * 
 * This example demonstrates basic memory operations:
 * - Storing data with "remember X is Y"
 * - Retrieving data with "what is X?"
 */
export default createAgent({
    manifest: './agent.json',

    handleTask: async (ctx: TaskContext) => {
        // Extract input from the task
        const { message } = ctx.task.input as { message: string };

        // Log the incoming message
        ctx.logger.info(`Processing message: ${message}`);

        let response = '';

        // Case 1: Remember something (store in memory)
        const rememberMatch = message.match(/remember(?:\s+that)?\s+(.+?)\s+is\s+(.+)/i);
        if (rememberMatch) {
            const [, key, value] = rememberMatch;
            const memoryKey = `fact:${key.trim().toLowerCase()}`;

            // Store in memory
            await ctx.memory.set<FactData>(memoryKey, {
                fact: key.trim(),
                value: value.trim()
            });

            response = `I'll remember that ${key.trim()} is ${value.trim()}.`;
        }
        // Case 2: Recall something (retrieve from memory)
        else if (message.toLowerCase().startsWith('what is ')) {
            const key = message.substring(8).trim(); // Remove "what is " and trim
            const memoryKey = `fact:${key.toLowerCase()}`;

            // Retrieve from memory
            const fact = await ctx.memory.get<FactData>(memoryKey);

            if (fact) {
                response = `${fact.fact} is ${fact.value}`;
            } else {
                response = `I don't know what ${key} is.`;
            }
        }
        // Default response
        else {
            response = `You can ask me to remember facts by saying "Remember X is Y" and then ask "What is X?"`;
        }

        // Send response
        await ctx.reply([{ type: 'text', text: response }]);

        // Complete the task
        ctx.complete(100, 'completed');
    }
}, import.meta.url);

