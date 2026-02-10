import { createAgent, ToolDefinition, AgentTaskContext } from '@a2arium/callagent-core';

// Define weather tool
const weatherTool: ToolDefinition = {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'The city and country, e.g. "London, UK"'
            }
        },
        required: ['location']
    },
    callFunction: async (params: any): Promise<any> => {
        console.log('get_weather called with params:', params);
        const result = {
            temperature: 20,
            conditions: 'sunny',
            humidity: 65
        };
        console.log('Result:', result);
        return result;
    }
};

// Define time tool
const timeTool: ToolDefinition = {
    name: 'get_time',
    description: 'Get the current time for a location',
    parameters: {
        type: 'object',
        properties: {
            location: {
                type: 'string',
                description: 'The city and country, e.g. "Tokyo, Japan"'
            }
        },
        required: ['location']
    },
    callFunction: async (params: any): Promise<any> => {
        console.log('get_time called with params:', params);
        const result = {
            time: new Date().toLocaleTimeString('en-US')
        };
        console.log('Result:', result);
        return result;
    }
};

export default createAgent({
    manifest: {
        name: 'tool-agent',
        version: '0.1.0',
        runMode: 'legacy'
    },
    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        systemPrompt: 'You are a helpful assistant that can call tools.',
        initialTools: [weatherTool, timeTool]
    },
    async handleTask(ctx: AgentTaskContext) {
        try {
            const input = ctx.task.input as any;
            const prompt = input?.prompt || "What's the weather in London and the time in Tokyo?";
            await ctx.reply(`🔍 Processing request: ${prompt}`);

            // Call LLM with the prompt
            // The callLLM library will automatically handle tool calls if tools are provided
            const responses = await ctx.llm.call(prompt);

            for (const resp of responses) {
                if (resp.content) {
                    await ctx.reply(`🤖 Assistant: ${resp.content}`);
                }
            }

            ctx.complete(100, 'success');
            return { status: 'ok' };

        } catch (error) {
            console.error('Task error:', error);
            await ctx.fail(error);
            throw error;
        }
    }
}, import.meta.url);
