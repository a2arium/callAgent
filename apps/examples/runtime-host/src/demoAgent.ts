import { createAgent, type AgentTaskContext } from '@a2arium/callagent-core';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const DEMO_AGENT_ID = 'streaming-demo-agent';

export async function registerDemoAgent(): Promise<void> {
    await createAgent({
        agentCard: { inline: {
            name: DEMO_AGENT_ID,
            version: '0.1.0',
            description: 'Demo agent for manual runtime streaming review.',
            supportedInterfaces: [{
                url: 'http://127.0.0.1:8790/rpc',
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
            }],
            capabilities: {
                streaming: true,
                pushNotifications: false,
            },
            defaultInputModes: ['text/plain', 'application/json'],
            defaultOutputModes: ['text/plain', 'application/json'],
            skills: [{
                id: 'streaming-demo',
                name: 'Streaming Demo',
                description: 'Emits progress, artifacts, optional input requests, and cognition debug events.',
            }],
            url: 'http://127.0.0.1:8790',
        } },
        runtimeManifest: { inline: {
            name: DEMO_AGENT_ID,
            version: '0.1.0',
            runMode: 'legacy',
            budgets: {
                maxTurns: 10,
            },
            observability: {
                turnTrace: {
                    enabled: true,
                    level: 'summary',
                },
            },
        } },
        handleTask: runStreamingDemo,
    }, import.meta.url);
}

async function runStreamingDemo(ctx: AgentTaskContext): Promise<void> {
    const input = extractInput(ctx.task.input);
    const text = typeof input.text === 'string' ? input.text : '';

    await maybeEmitCognitionEvents(ctx);

    ctx.progress(10, 'Accepted task');
    await delay(250);

    await (ctx.reply as (parts: string, opts?: { append?: boolean; artifactName?: string; lastChunk?: boolean }) => Promise<void>)('First artifact chunk. ', { append: true, artifactName: 'runtime-demo' });
    await delay(250);

    ctx.progress(45, 'Streaming artifact output');
    await (ctx.reply as (parts: string, opts?: { append?: boolean; artifactName?: string; lastChunk?: boolean }) => Promise<void>)('Second artifact chunk. ', { append: true, artifactName: 'runtime-demo' });
    await delay(250);

    if (/\b(input|ask|prompt)\b/i.test(text)) {
        const handle = await ctx.requestInput('Need one more value to continue.', {
            ttlMs: 5 * 60_000,
        });
        ctx.progress({
            state: 'working',
            timestamp: new Date().toISOString(),
            metadata: {
                waitingForInputToken: handle.token,
            },
        });
        return;
    }

    ctx.progress(80, 'Finishing task');
    await (ctx.reply as (parts: string, opts?: { append?: boolean; artifactName?: string; lastChunk?: boolean }) => Promise<void>)('Final artifact chunk.', {
        append: true,
        artifactName: 'runtime-demo',
        lastChunk: true,
    });
    await delay(150);
    ctx.complete(100, 'completed');
}

async function maybeEmitCognitionEvents(ctx: AgentTaskContext): Promise<void> {
    try {
        await ctx.goals?.add({
            title: 'Review runtime streaming manually',
            type: 'short',
            priority: 1,
        });
    } catch {
        /* optional in this demo */
    }

    try {
        await ctx.thoughts?.add('Streaming demo is emitting observable runtime facts.');
    } catch {
        /* optional in this demo */
    }

    try {
        await ctx.decisions?.add('streaming-demo.mode', 'manual-review', 'Demonstrate live runtime events.');
    } catch {
        /* optional in this demo */
    }
}

function extractInput(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const record = input as Record<string, unknown>;
        const nested = record.input;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            return nested as Record<string, unknown>;
        }
        return record;
    }
    return {};
}
