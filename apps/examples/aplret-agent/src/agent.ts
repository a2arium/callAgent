import { createAgent } from '../../../../packages/core/src/index.js';
import type {
    MentalState,
    AttentionSignal,
    ExecErrorPayload,
    TurnOutcome,
    ProposedAction,
    ToolDefinition
} from '../../../../packages/core/src/index.js';

type Sensory = { current?: string };
type Obs = { text?: string; eventType: 'user_message' | 'idle' };

type ObservationConfig = {
    user: string | { text?: string; input?: string };
    tool: unknown;
    child: unknown;
};

// Define simple tools for telemetry demonstration
const weatherTool: ToolDefinition = {
    name: 'get_weather',
    description: 'Get current weather in a location',
    parameters: {
        type: 'object' as const,
        properties: {
            location: { type: 'string' }
        },
        required: ['location']
    },
    callFunction: (async (args: any) => {
        console.log(`get_weather called with params:`, args);
        return { temperature: 20, conditions: 'sunny', humidity: 65 };
    }) as any
};

const timeTool: ToolDefinition = {
    name: 'get_time',
    description: 'Get current time in a location',
    parameters: {
        type: 'object' as const,
        properties: {
            location: { type: 'string' }
        },
        required: ['location']
    },
    callFunction: (async (args: any) => {
        console.log(`get_time called with params:`, args);
        return { time: new Date().toLocaleTimeString() };
    }) as any
};

// Create agent with loop modules
export const agent = createAgent<Sensory, Obs, AttentionSignal, unknown, ExecErrorPayload, ObservationConfig>({
    manifest: '../agent.json',
    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        initialTools: [weatherTool, timeTool]
    },

    attention: (_m, _env) => ({ wantPrompt: false }),

    perception: (env): Obs => {
        return { eventType: 'idle' };
    },

    learning: (prev, _action, _obs): MentalState<Sensory> => {
        const vars = prev.memory.vars || {};
        const currentCount = (vars.count as number) || 0;
        return {
            ...prev,
            memory: {
                ...prev.memory,
                vars: {
                    ...vars,
                    count: currentCount + 1
                }
            }
        };
    },

    policy: (m): ProposedAction => {
        const count = (m.memory.vars?.count as number) || 0;
        if (count < 3) {
            return { kind: 'internal', intent: 'count_increment', data: { count } };
        }
        return { kind: 'internal', intent: 'count_finished' };
    },

    shield: (_m, intent) => ({ action: 'pass', intent }),

    execution: async (intent, ctx) => {
        if (intent.kind === 'internal' && intent.intent === 'count_increment') {
            const count = (intent.data as any).count + 1;

            // Make an LLM call on turn 1 to test nested telemetry with tools
            if ((intent.data as any).count === 1) {
                const res = await ctx.llm.call('Check weather in London and time in Tokyo. Be brief.');
                await ctx.reply(res[0]?.content ?? 'Count: 1');
            } else if ((intent.data as any).count === 2) {
                const base64Image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
                const res = await ctx.llm.call({
                    text: "Describe what you see.",
                    file: base64Image,
                    input: {
                        image: {
                            detail: "low" // Changed to low to save tokens/speed, but tests the structure
                        }
                    }
                });
                await ctx.reply(res[0]?.content ?? 'Count: 2');
            } else {
                await ctx.reply(`Count: ${count}`);
            }

            await ctx.progress(33 * count, `Counting ${count}...`);
            return { action: { kind: 'internal', done: false, data: { count: (intent.data as any).count } }, result: { status: 'ok' } };
        }
        await ctx.reply('Finished counting!');
        return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
    },

    transition: (_env, exec): TurnOutcome<ObservationConfig> => {
        if (exec.action.kind === 'internal' && (exec.action as any).done === false) return { kind: 'continue', observations: [] };
        return { kind: 'complete', result: { ok: true } };
    }
}, import.meta.url);
