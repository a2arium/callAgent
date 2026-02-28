import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
dotenv.config({ path: path.resolve(__filename, '../../../../.env') });

import { createAgent, outboxPublisher } from '@a2arium/callagent-core';
import { runAgentWithStreaming, PluginManager } from '@a2arium/callagent-core';


// This is our test APLRET agent with Tool and MCP Calling support.
const McpAndToolAgent = createAgent({
    manifest: {
        name: 'test-mcp-agent',
        version: '1.0.0',
        description: 'Demonstrates Sync and Async MCP and Tool calling'
    },
    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'gpt-4o-mini',
        mcpServers: {
            filesystem: {
                command: "npx",
                args: [
                    "-y",
                    "@modelcontextprotocol/server-filesystem",
                    // We'll test reading the current directory and desktop
                    process.cwd()
                ]
            }
        },
        initialTools: [
            {
                name: 'local_echo',
                description: 'A local standard tool that echoes the input',
                parameters: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message']
                },
                callFunction: async (args: any): Promise<any> => {
                    return `Echo from standard tool: ${args.message}`;
                }
            }
        ]
    },

    // Removed initialState as it's not part of CreateAgentPluginOptions and memory is lazy-initialized
    perception: (env) => {
        // Check current events
        const events = env.inbox.current || [];
        console.log(`[Perception] Inbox current length: ${events.length}. Kinds: ${JSON.stringify(events.map(e => e.kind))}`);
        const state: Record<string, any> = { prompt: '' };

        for (const event of events) {
            console.log(`[Perception] Processing event kind: ${event.kind}, source: ${event.source}`);
            if (event.source === 'user') {
                state.prompt = event.payload;
            } else if (event.source === 'tool') {
                const payload = event.payload as any;
                // Get the tool name from the payload so we can track results properly
                const toolName = payload?.tool || event.kind || 'unknown_tool';
                state[`tool_result_${toolName}`] = payload?.result || payload;
                console.log(`[Perception] Tool '${toolName}' result extracted as:`, state[`tool_result_${toolName}`] ? 'PRESENT' : 'MISSING');
            }
        }
        console.log(`[Perception] Output state keys:`, Object.keys(state));
        return state;
    },

    learning: (prev: any, _prevAction: any, obs: any) => {
        const memory = prev.memory || {};
        const vars = { ...(memory.vars as Record<string, unknown>) };
        if (obs?.prompt) vars.prompt = obs.prompt;

        // Map async tool results from perception into vars
        console.log("[Learning] Processing observations:", JSON.stringify(Object.keys(obs || {})));
        const asyncResult = obs && obs['tool_result_mcp:filesystem.list_directory'];
        if (asyncResult) {
            vars.asyncFsResult = asyncResult;
            vars.asyncFsDone = true;
            console.log("==> [Step 2] LEARNING: ASYNC MCP list_directory result mapped to vars. asyncFsDone = true");

            // Extract and format the listing text for better readability
            const listingText = (asyncResult as any)?.content?.[0]?.text || (asyncResult as any)?.structuredContent?.content;
            if (listingText) {
                console.log("==> [Step 2] Directory listing:\n" + listingText);
            } else {
                console.log("==> [Step 2] Directory listing (raw):", JSON.stringify(asyncResult, null, 2));
            }
        } else {
            console.log("[Learning] No async tool result found in obs. Keys present:", Object.keys(obs || {}));
        }
        if (obs?.tool_result_local_echo) {
            vars.asyncEchoResult = obs.tool_result_local_echo;
        }

        return { ...prev, memory: { ...memory, vars } };
    },

    policy: (m) => {
        const memory = m.memory || {};
        const vars = (memory.vars || {}) as Record<string, any>;
        console.log(`[Policy] Current vars:`, {
            syncFsDone: !!vars.syncFsDone,
            asyncFsFired: !!vars.asyncFsFired,
            asyncFsDone: !!vars.asyncFsDone,
            localToolDone: !!vars.localToolDone
        });

        // State machine: sync MCP → fire async MCP → await async result → local tool → finish
        if (!vars.syncFsDone) {
            return { kind: 'internal', intent: 'intent_mcp_sync', data: { explanation: 'Step 1: Sync MCP list_allowed_directories' } };
        }
        if (!vars.asyncFsFired) {
            return { kind: 'internal', intent: 'intent_mcp_async_fire', data: { explanation: 'Step 2a: Fire async MCP list_directory' } };
        }
        if (!vars.asyncFsDone) {
            // Waiting for the async result — this state will be reached after the tool completes
            return { kind: 'internal', intent: 'intent_await_async', data: { explanation: 'Step 2b: Waiting for async MCP result' } };
        }
        if (!vars.localToolDone) {
            return { kind: 'internal', intent: 'intent_local_tool', data: { explanation: 'Step 3: Local tool echo (tests tool registration)' } };
        }
        return { kind: 'internal', intent: 'intent_finish' };
    },

    execution: async (action: any, ctx: any, _mem: any, m: any) => {
        m.memory = m.memory || {};
        m.memory.vars = m.memory.vars || {};

        if (action.kind === 'internal' && action.intent === 'intent_mcp_sync') {
            const result = await ctx.requestTool('mcp:filesystem.list_allowed_directories', {}, { awaitCompletion: true });
            console.log("==> [Step 1] SYNC MCP list_allowed_directories:", JSON.stringify(result?.structuredContent || result, null, 2));
            m.memory.vars.syncFsDone = true;
            return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
        }

        if (action.kind === 'internal' && action.intent === 'intent_mcp_async_fire') {
            // Fire-and-forget: no awaitCompletion — truly async!
            const handle = await ctx.requestTool('mcp:filesystem.list_directory', { path: process.cwd() });
            console.log("==> [Step 2a] ASYNC MCP list_directory FIRED, token:", handle?.token);
            m.memory.vars.asyncFsFired = true;
            m.memory.vars.asyncToolToken = handle?.token;
            // Return a tool action with the token so transition can await_tool
            return { action: { kind: 'tool', token: handle?.token }, result: { status: 'ok' } };
        }

        if (action.kind === 'internal' && action.intent === 'intent_await_async') {
            // The async result should already be in m.memory.vars.asyncFsResult via learning
            console.log("==> [Step 2b] Async result already captured by learning");
            return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
        }

        if (action.kind === 'internal' && action.intent === 'intent_local_tool') {
            // This used to fail with "Tool not found" before Fix 3 — now registered from llmConfig.tools
            const result = await ctx.requestTool('local_echo', { message: "Hello from APLRET!" }, { awaitCompletion: true });
            console.log("==> [Step 3] LOCAL TOOL local_echo:", result);
            m.memory.vars.localToolDone = true;
            return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
        }

        if (action.kind === 'internal' && action.intent === 'intent_finish') {
            console.log("==> [Step 4] FINISH: All sync MCP + async MCP + local tool tests passed!");
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'ok', data: 'Completed all MCP and tool tests!' }
            };
        }

        return { action: { kind: 'internal', done: true }, result: { status: 'error', reason: 'unknown intent' } };
    },

    transition: (env: any, exec: any) => {
        if (exec.action.kind === 'tool' && exec.action.token) {
            return { kind: 'await_tool', token: exec.action.token };
        }
        if (exec.action.kind === 'internal' && exec.result?.data) {
            return { kind: 'complete', result: exec.result.data };
        }
        return { kind: 'continue', observations: [] };
    }
}, import.meta.url);
export default McpAndToolAgent;

async function run() {
    console.log("Running McpAndToolAgent Demo...\n");
    // Register it manually so findAgent can locate it
    PluginManager.registerAgent(McpAndToolAgent);
    // Since we are running the file directly, we pass the file path.
    // Setting resolveDeps: false tells the loader to just import THIS file
    // and then look it up in the PluginManager registry.
    const result = await runAgentWithStreaming(
        __filename,
        { text: 'start' },
        {
            isStreaming: true,
            outputType: 'console',
            resolveDeps: false,
            maxTurns: 10
        }
    );
    console.log("\nAgent execution finished!", result);
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(console.error).finally(async () => {
        await outboxPublisher.stop();
        process.exit(0);
    });
}
