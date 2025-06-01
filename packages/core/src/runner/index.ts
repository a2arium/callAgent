import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type MinimalConfig } from '../config/index.js';
import { listPlugins } from '../core/plugin/pluginRegistry.js';
import type { TaskContext, TaskInput, MessagePart } from '../shared/types/index.js';
import type { TaskStatus } from '../shared/types/StreamingEvents.js';
import type { AgentPlugin } from '../core/plugin/types.js';
import { logger } from '@callagent/utils';
import { AgentError, TaskExecutionError } from '../utils/errors.js';
import type { UniversalChatResponse, UniversalStreamResponse } from 'callllm';
import { createLLMForTask } from '../core/llm/LLMFactory.js';
import { extendContextWithStreaming } from '../core/context/StreamingContext.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { eventBus } from '../eventbus/inMemoryEventBus.js';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent, A2AEvent } from '../shared/types/StreamingEvents.js';
import { SemanticMemoryRegistry } from '../core/memory/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from '../core/memory/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from '../core/memory/EmbedMemoryRegistry.js';
import { MemorySQLAdapter } from '@callagent/memory-sql';
import { PrismaClient } from '@prisma/client';

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
            `No plugin registered by file ${agentFilePath}. Ensure the file exports the result of createAgent.`,
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

    // Debug logging to check plugin state
    runnerLogger.info(`Plugin found: ${plugin.manifest.name}`, {
        hasLLMAdapter: !!plugin.llmAdapter,
        hasLLMConfig: !!plugin.llmConfig,
        llmConfigDetails: plugin.llmConfig ? {
            provider: plugin.llmConfig.provider,
            model: plugin.llmConfig.modelAliasOrName
        } : 'none'
    });

    // --- Create Task Context ---
    let taskCtx: TaskContext;

    // Create the agent-specific logger using the nested createLogger method
    const agentLogger = runnerLogger.createLogger({ prefix: agentName });

    const prismaClient = new PrismaClient();
    const sqlAdapter = new MemorySQLAdapter(prismaClient, undefined, {
        defaultTenantId: plugin.tenantId
    });
    const semanticBackends = {
        sql: sqlAdapter,
    };
    // For now, only wire up semantic memory; stub the others for future extension
    const episodicBackends = {};
    const embedBackends = {};

    const memory = {
        semantic: new SemanticMemoryRegistry(
            pickBackends(semanticBackends, config.memory.semantic.backends),
            config.memory.semantic.default
        ),
        episodic: new EpisodicMemoryRegistry(episodicBackends, ''), // TODO: Implement episodic memory adapter
        embed: new EmbedMemoryRegistry(embedBackends, ''), // TODO: Implement embed memory adapter
    };

    const partialCtx: Omit<TaskContext, 'fail'> = {
        tenantId: plugin.tenantId,
        task: {
            id: `local-task-${Date.now()}`,
            input: input,
        },
        // Use agentLogger for context methods that log
        reply: async (parts: string | string[] | MessagePart | MessagePart[]) => {
            agentLogger.info(`Agent Reply (stub - should be overridden):`, { parts });
        },
        progress: (pctOrStatus: number | TaskStatus, msg?: string) => {
            if (typeof pctOrStatus === 'number') {
                agentLogger.info(`Agent Progress: ${pctOrStatus}%${msg ? `: ${msg}` : ''}`);
            } else {
                // Handle TaskStatus object
                agentLogger.info(`Agent Status: ${pctOrStatus.state}`, pctOrStatus);
            }
        },
        complete: (pct?: number, status?: string) => {
            agentLogger.info(`Agent Complete: ${status || 'completed'} at ${pct ?? 100}%`);
        },
        llm: plugin.llmAdapter || {
            async call<T = unknown>(message: string, options?: Record<string, any>): Promise<UniversalChatResponse<T>[]> {
                agentLogger.warn(`llm.call is stubbed (no LLM adapter configured)`, { message, options });
                return [{
                    content: "Stubbed LLM response - agent has no llmConfig",
                    role: "assistant"
                } as UniversalChatResponse<T>];
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
        memory: memory,
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
        },
        recordUsage: (cost: number | { cost: number } | any): void => {
            let costValue: number;

            if (typeof cost === 'number') {
                costValue = cost;
            } else if ('cost' in cost) {
                costValue = cost.cost;
            } else if (cost?.costs?.total) {
                costValue = cost.costs.total;
            } else {
                costValue = 0;
            }

            if (costValue > 0) {
                agentLogger.info(`Usage recorded: $${costValue.toFixed(6)}`, { cost: costValue });
            }
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

    // Replace the LLM stub with a real implementation if we have a config
    if (!plugin.llmAdapter && plugin.llmConfig) {
        // Now we can safely use taskCtx since it's fully created
        runnerLogger.info(`Creating LLM using factory for plugin ${plugin.manifest.name}`, {
            provider: plugin.llmConfig.provider,
            model: plugin.llmConfig.modelAliasOrName
        });
        taskCtx.llm = createLLMForTask(plugin.llmConfig, taskCtx);
    } else {
        runnerLogger.warn(`Not creating LLM - plugin ${plugin.manifest.name} has no config`, {
            hasAdapter: !!plugin.llmAdapter,
            hasConfig: !!plugin.llmConfig
        });
    }

    // Apply streaming context extensions to get proper reply function
    extendContextWithStreaming(taskCtx, true);

    // Setup console output for events
    setupConsoleOutput(taskCtx.task.id);

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
 * Setup console output for event emissions from the task
 * @param taskId - The ID of the task to listen for
 */
function setupConsoleOutput(taskId: string): void {
    // Define the handler as a separate function
    const handler = (event: A2AEvent): void => {
        const logger = console;

        if ('artifact' in event) {
            // Display artifacts (replies)
            const artifactEvent = event as TaskArtifactUpdateEvent;
            const artifact = artifactEvent.artifact;
            if (artifact && artifact.parts) {
                artifact.parts.forEach(part => {
                    if (part.type === 'text' && part.text) {
                        logger.log('\n--- response ---');
                        logger.log(part.text);
                    } else {
                        logger.log('Non-text artifact part:', part);
                    }
                });
            }
        }

        if ('status' in event) {
            const statusEvent = event as TaskStatusUpdateEvent;
            const status = statusEvent.status;

            // Display progress messages for intermediate states
            if (status.state === 'working' && status.message?.parts) {
                const textParts = status.message.parts
                    .filter(part => part.type === 'text')
                    .map(part => (part as { text?: string }).text)
                    .filter(Boolean);

                if (textParts.length > 0) {
                    // Check if there's a progress percentage
                    const progressPercentage = status.metadata?.progress;
                    if (typeof progressPercentage === 'number') {
                        logger.log(`Progress: ${progressPercentage}% - ${textParts.join(' ')}`);
                    } else {
                        logger.log(`Progress: ${textParts.join(' ')}`);
                    }
                }
            } else if (status.state === 'working') {
                // Check if there's just a progress percentage without message
                const progressPercentage = status.metadata?.progress;
                if (typeof progressPercentage === 'number') {
                    logger.log(`Progress: ${progressPercentage}%`);
                }
            }

            if (status.state === 'completed' || status.state === 'failed') {
                // Show accumulated cost if available
                if (status.metadata?.usage && typeof status.metadata.usage === 'object') {
                    const usage = status.metadata.usage as any;
                    if (usage.costs?.total) {
                        logger.log(`\nTotal cost: $${usage.costs.total.toFixed(6)}`);
                    }
                }

                // Unsubscribe when task is complete
                eventBus.unsubscribe(taskChannel(taskId), handler);
            }
        }
    };

    // Subscribe with the handler
    eventBus.subscribe<A2AEvent>(taskChannel(taskId), handler);
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

/**
 * Helper to pick only the named backends from all available
 * @param allBackends Map of all backend instances
 * @param names Array of backend names to include
 */
function pickBackends<T>(allBackends: Record<string, T>, names: string[]): Record<string, T> {
    return Object.fromEntries(Object.entries(allBackends).filter(([k]) => names.includes(k)));
} 