import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type MinimalConfig } from '../config/index.js';
import { listPlugins } from '../core/plugin/pluginRegistry.js';
import type { TaskContext, TaskInput, MessagePart } from '../shared/types/index.js';
import type { AgentPlugin } from '../core/plugin/types.js';
import { logger } from '../utils/logger.js';
import { AgentError, TaskExecutionError } from '../utils/errors.js';
import type { UniversalChatResponse, UniversalStreamResponse } from 'callllm';

// Create base runner logger
const runnerLogger = logger.createLogger({ prefix: 'Runner' });

// Detect if running in dev mode with ts-node
const isDevMode = process.argv[0].includes('ts-node') || process.argv[1].includes('ts-node');

/**
 * Run an agent locally with the given input
 * @param agentFilePath - Path to the agent module file
 * @param input - Input data for the agent
 * @throws {TaskExecutionError} If agent execution fails
 */
async function runAgentLocally(agentFilePath: string, input: TaskInput): Promise<void> {
    const config: MinimalConfig = loadConfig();
    runnerLogger.info(`Loading plugin from ${agentFilePath}...`);

    let plugin: AgentPlugin | undefined;
    try {
        // Resolve path and convert to file URL
        const agentModulePath = path.resolve(agentFilePath);

        // When in dev mode, ts-node may be running, so the file might be a .ts file,
        // otherwise we expect it to be a .js file in the dist directory
        if (isDevMode) {
            runnerLogger.debug(`Running in development mode (ts-node)`);
            // In dev mode we can import .ts files directly
        } else {
            // In production mode, verify we're importing from dist
            if (!agentModulePath.includes('dist')) {
                runnerLogger.warn(`In production mode, agent paths should typically be from the 'dist' directory.`, {
                    path: agentModulePath
                });
            }
        }

        const agentModuleUrl = `file://${agentModulePath}`;
        await import(agentModuleUrl);
    } catch (error: unknown) {
        runnerLogger.error(`Failed to load agent file`, error, { path: agentFilePath });
        throw new TaskExecutionError(`Failed to load agent module from ${agentFilePath}`, {
            path: agentFilePath,
            originalError: error
        });
    }
    runnerLogger.info(`Plugin loaded successfully`);

    const plugins: AgentPlugin[] = listPlugins();
    if (plugins.length === 0) {
        runnerLogger.error(`No plugin registered by file`, null, { path: agentFilePath });
        throw new TaskExecutionError(
            `No plugin registered by file ${agentFilePath}. Ensure the file exports the result of createAgentPlugin.`,
            { path: agentFilePath }
        );
    }

    // Heuristic: try to find the plugin whose file path roughly matches the input
    const filename = path.basename(agentFilePath);

    // Try to find plugin by matching names in the path
    plugin = plugins.find((p: AgentPlugin) => agentFilePath.includes(p.manifest.name));

    // If not found and only one plugin, use that
    if (!plugin && plugins.length === 1) {
        plugin = plugins[0];
        runnerLogger.warn(`Could not definitively match plugin by name in path, using the only registered plugin`, {
            name: plugin.manifest.name,
            path: agentFilePath
        });
    }

    if (!plugin) {
        const availablePlugins = plugins.map((p: AgentPlugin) => p.manifest.name).join(', ');
        runnerLogger.error(`Could not determine which plugin to run`, null, {
            path: agentFilePath,
            availablePlugins
        });
        throw new TaskExecutionError(
            `Could not determine which plugin to run from ${agentFilePath}. Found: ${availablePlugins}`,
            { path: agentFilePath, availablePlugins }
        );
    }

    const agentName = plugin.manifest.name;
    // Use base runner logger here
    runnerLogger.info(`Running agent '${agentName}' (v${plugin.manifest.version})`);

    // --- Create Task Context ---
    let taskCtx: TaskContext;

    // Create the agent-specific logger using the nested createLogger method
    const agentLogger = runnerLogger.createLogger({ prefix: agentName });

    const partialCtx: Omit<TaskContext, 'fail'> = {
        task: {
            id: `local-task-${Date.now()}`,
            input: input,
        },
        // Use agentLogger for context methods that log
        reply: async (parts: MessagePart[]) => {
            agentLogger.info(`Agent Reply:`, { parts });
        },
        progress: (pct: number, msg?: string) => {
            agentLogger.info(`Agent Progress: ${pct}%${msg ? `: ${msg}` : ''}`);
        },
        complete: (pct?: number, status?: string) => {
            agentLogger.info(`Agent Complete: ${status || 'completed'} at ${pct ?? 100}%`);
        },
        llm: plugin.llmAdapter || {
            async call<T = unknown>(message: string, options?: Record<string, any>): Promise<UniversalChatResponse<T>> {
                agentLogger.warn(`llm.call is stubbed (no LLM adapter configured)`, { message, options });
                return {
                    content: "Stubbed LLM response - agent has no llmConfig",
                    role: "assistant"
                } as UniversalChatResponse<T>;
            },
            async *stream<T = unknown>(message: string, options?: Record<string, any>): AsyncIterable<UniversalStreamResponse<T>> {
                agentLogger.warn(`llm.stream is stubbed (no LLM adapter configured)`, { message, options });
                yield {
                    content: "Stubbed LLM response - agent has no llmConfig",
                    role: "assistant",
                    isComplete: true
                } as UniversalStreamResponse<T>;
            },
            addToolResult(id: string, result: string, name: string): void {
                agentLogger.warn(`llm.addToolResult is stubbed (no LLM adapter configured)`, { id, name });
            },
            updateSettings(settings: Record<string, any>): void {
                agentLogger.warn(`llm.updateSettings is stubbed (no LLM adapter configured)`, { settings });
            }
        },
        tools: {
            invoke: async <T = unknown>(toolName: string, args: unknown): Promise<T> => {
                agentLogger.warn(`tools.invoke is stubbed`, { toolName, args });
                return Promise.resolve({ success: true, output: "Stubbed tool result" } as T);
            }
        },
        // Assign the agentLogger directly
        logger: agentLogger,
        memory: {
            get: async <T = unknown>(key: string): Promise<T | null> => { agentLogger.warn(`memory.get is stubbed`, { key }); return null; },
            set: async <T = unknown>(key: string, value: T): Promise<void> => { agentLogger.warn(`memory.set is stubbed`, { key }); },
            query: async <T = unknown>(opts: unknown): Promise<Array<{ key: string; value: T }>> => { agentLogger.warn(`memory.query is stubbed`, { opts }); return []; },
            delete: async (key: string): Promise<void> => { agentLogger.warn(`memory.delete is stubbed`, { key }); }
        },
        cognitive: {
            loadWorkingMemory: (e: unknown): void => { agentLogger.warn(`cognitive.loadWorkingMemory is stubbed`, { e }); },
            plan: async (prompt: string, options?: unknown): Promise<unknown> => { agentLogger.warn(`cognitive.plan is stubbed`, { prompt, options }); return { steps: [] }; },
            record: (state: unknown): void => { agentLogger.warn(`cognitive.record is stubbed`, { state }); },
            flush: async (): Promise<void> => { agentLogger.warn(`cognitive.flush is stubbed`); }
        },
        config: config,
        validate: (schema: unknown, data: unknown): void => { agentLogger.warn(`validate is stubbed`, { schema, data }); /* No-op */ },
        retry: async <T = unknown>(fn: () => Promise<T>, opts: unknown): Promise<T> => { agentLogger.warn(`retry is stubbed`, { opts }); return fn(); },
        cache: {
            get: async <T = unknown>(key: string): Promise<T | null> => { agentLogger.warn(`cache.get is stubbed`, { key }); return null; },
            set: async <T = unknown>(key: string, value: T, ttl?: number): Promise<void> => { agentLogger.warn(`cache.set is stubbed`, { key, ttl }); },
            delete: async (key: string): Promise<void> => { agentLogger.warn(`cache.delete is stubbed`, { key }); }
        },
        emitEvent: async (channel: string, payload: unknown): Promise<void> => { agentLogger.warn(`emitEvent is stubbed`, { channel, payload }); },
        updateStatus: (state: string): void => { agentLogger.info(`Agent Status Update: -> ${state}`); },
        services: { get: <T = unknown>(name: string): T | undefined => { agentLogger.warn(`services.get is stubbed`, { name }); return undefined; } },
        getEnv: (key: string, defaultValue?: string): string | undefined => process.env[key] ?? defaultValue,
        throw: (code: string, message: string, details?: unknown): never => {
            // Use the specific agentLogger here
            agentLogger.error(`Agent threw structured error: [${code}] ${message}`, null, { details });
            throw new AgentError(message, agentName, { code, details });
        }
    };

    taskCtx = {
        ...partialCtx,
        fail: async (error: unknown): Promise<void> => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Use agentLogger here
            agentLogger.error(`Agent task failed`, error, { taskId: taskCtx.task.id });

            const errorPart: MessagePart = {
                type: 'text',
                text: `Sorry, I encountered an error: ${errorMessage}`
            };

            try {
                await taskCtx.reply([errorPart]);
            } catch (replyError) {
                // Use agentLogger here
                agentLogger.error(`Failed to send error reply to client`, replyError);
            }

            try {
                taskCtx.complete(100, 'failed');
            } catch (completeError) {
                // Use agentLogger here
                agentLogger.error(`Failed to mark task as complete after failure`, completeError);
            }
            // Use agentLogger here
            agentLogger.info(`Task ${taskCtx.task.id} marked as failed.`);
        },
    };

    // --- Execute Agent ---
    // Use agentLogger here
    agentLogger.info(`Starting Agent Execution for Task ${taskCtx.task.id}`);
    try {
        await plugin.handleTask(taskCtx);
        if (taskCtx.complete) {
            taskCtx.complete();
        }
        // Use agentLogger here
        agentLogger.info(`Agent Execution Finished Successfully for Task ${taskCtx.task.id}`);
    } catch (error: unknown) {
        // Use agentLogger here
        agentLogger.error(`Unhandled Agent Execution Error`, error, {
            taskId: taskCtx.task.id
        });

        try {
            if (taskCtx.fail) {
                await taskCtx.fail(new Error('Unhandled exception during task execution'));
            } else {
                taskCtx.complete(100, 'failed_unhandled');
            }
        } catch { /* ignore double failure */ }

        if (error instanceof AgentError) {
            throw error;
        }
        if (error instanceof Error) {
            throw new AgentError(error.message, agentName, {
                originalError: error,
                taskId: taskCtx.task.id
            });
        } else {
            throw new AgentError('Unknown agent error', agentName, {
                originalError: error,
                taskId: taskCtx.task.id
            });
        }
    }
}

/**
 * Main entry point for the runner
 * Parses command line arguments and runs the specified agent
 */
async function main(): Promise<void> {
    const agentFileArg = process.argv[2];
    const inputJsonArg = process.argv[3] || '{}';

    if (!agentFileArg) {
        runnerLogger.error(`Missing required argument: agent file path`);
        console.error("Usage: yarn dev <path-to-agent-module.ts> [json-input-string]");
        console.error(`Example: ${isDevMode ? 'yarn dev examples/hello-agent/AgentModule.ts' : 'yarn start dist/examples/hello-agent/AgentModule.js'} '{"name": "World"}'`);
        process.exit(1);
    }

    let input: TaskInput;
    try {
        input = JSON.parse(inputJsonArg);
        runnerLogger.debug('Parsed input', { input });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        runnerLogger.error(`Invalid JSON input`, e, { input: inputJsonArg });
        console.error(`Invalid JSON input provided: ${inputJsonArg} `);
        process.exit(1);
    }

    await runAgentLocally(agentFileArg, input);
}

main().catch(err => {
    runnerLogger.error(`Unhandled error in runner`, err);
    process.exit(1);
}); 