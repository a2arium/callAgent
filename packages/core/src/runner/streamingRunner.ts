import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, type MinimalConfig } from '../config/index.js';
import { listPlugins } from '../core/plugin/pluginRegistry.js';
import type { TaskContext, TaskInput, MessagePart } from '../shared/types/index.js';
import type { TaskStatus, Artifact } from '../shared/types/StreamingEvents.js';
import type { AgentPlugin } from '../core/plugin/types.js';
import { logger, type LoggerConfig } from '@callagent/utils';
import { AgentError, TaskExecutionError } from '../utils/errors.js';
import type { UniversalChatResponse, UniversalStreamResponse } from 'callllm';
import { eventBus } from '../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../core/context/StreamingContext.js';
import type { A2AEvent, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '../shared/types/StreamingEvents.js';
import fs from 'node:fs';
import { createLLMForTask } from '../core/llm/LLMFactory.js';
import { getMemoryAdapter } from '../core/memory/factory.js';
import { SemanticMemoryRegistry } from '../core/memory/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from '../core/memory/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from '../core/memory/EmbedMemoryRegistry.js';

// Create base runner logger
const runnerLogger = logger.createLogger({ prefix: 'StreamingRunner' });

// Detect if running in dev mode with ts-node
const isDevMode = process.argv[0].includes('ts-node') || process.argv[1].includes('ts-node');

type StreamingOptions = {
    isStreaming: boolean;
    outputType?: 'json' | 'sse' | 'console';
    outputFile?: string;
};

/**
 * Run an agent locally with the given input and streaming options
 * @param agentFilePath - Path to the agent module file
 * @param input - Input data for the agent
 * @param options - Streaming and output options
 * @throws {TaskExecutionError} If agent execution fails
 */
export async function runAgentWithStreaming(
    agentFilePath: string,
    input: TaskInput,
    options: StreamingOptions
): Promise<void> {
    const config: MinimalConfig = loadConfig();

    // Determine log method based on output format for runner logs
    const logInfoMethod = (options.outputType === 'json' || options.outputType === 'sse') ? runnerLogger.warn : runnerLogger.info;

    logInfoMethod.call(runnerLogger, `Loading plugin from ${agentFilePath}...`);

    let plugin: AgentPlugin | undefined;
    try {
        // Resolve path and convert to file URL
        const agentModulePath = path.resolve(agentFilePath);
        const agentModuleUrl = pathToFileURL(agentModulePath).href;
        await import(agentModuleUrl);
    } catch (error: unknown) {
        runnerLogger.error(`Failed to load agent file`, error, { path: agentFilePath });
        throw new TaskExecutionError(`Failed to load agent module from ${agentFilePath}`, {
            path: agentFilePath,
            originalError: error
        });
    }
    logInfoMethod.call(runnerLogger, `Plugin loaded successfully`);

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
    logInfoMethod.call(runnerLogger, `Running agent '${agentName}' (v${plugin.manifest.version}) with streaming=${options.isStreaming}`);

    // --- Create Task Context ---
    const taskId = `local-task-${Date.now()}`;

    // Set up event listeners for streaming output if needed
    if (options.isStreaming) {
        setupStreamListeners(taskId, options);
    } else {
        // Even in non-streaming mode, we want to see progress events in real-time
        setupProgressListeners(taskId);
    }

    // Create the agent-specific logger using the nested createLogger method
    const agentLogger = runnerLogger.createLogger({ prefix: agentName });

    // Get the memory adapter instance
    const memoryAdapter = await getMemoryAdapter();
    const semanticBackends = memoryAdapter.semantic.backends;
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

    // Create basic task context
    const partialCtx: Omit<TaskContext, 'fail'> = {
        task: {
            id: taskId,
            input: input,
        },
        // These methods will be overridden by extendContextWithStreaming
        reply: async (parts: string | string[] | MessagePart | MessagePart[]) => {
            agentLogger.info(`Agent Reply (stub - overridden by StreamingContext):`, { parts });
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
        memory,
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
        recordUsage: (usage: unknown): void => {
            agentLogger.warn('recordUsage is stubbed in local runner', { usage });
        }
    };

    let taskCtx: TaskContext = {
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

    // Extend the context with streaming capabilities
    extendContextWithStreaming(taskCtx, options.isStreaming);

    // Replace the LLM stub with a real implementation if we have a config
    if (!plugin.llmAdapter && plugin.llmConfig) {
        // Now we can safely use taskCtx since it's fully created
        logInfoMethod.call(runnerLogger, `Creating LLM using factory for plugin ${plugin.manifest.name}`, {
            provider: plugin.llmConfig.provider,
            model: plugin.llmConfig.modelAliasOrName
        });
        taskCtx.llm = createLLMForTask(plugin.llmConfig, taskCtx);
    } else if (!plugin.llmAdapter) {
        logInfoMethod.call(runnerLogger, `Not creating LLM - plugin ${plugin.manifest.name} has no config`, {
            hasAdapter: !!plugin.llmAdapter,
            hasConfig: !!plugin.llmConfig
        });
    }

    // --- Execute Agent ---
    // Use agentLogger here (agentLogger.info goes to stdout, which is fine as agent logs will use debug)
    agentLogger.info(`Starting Agent Execution for Task ${taskCtx.task.id}`);
    try {
        // For streaming mode, we don't await completion
        if (options.isStreaming) {
            // We'll start the agent execution but not await its completion
            plugin.handleTask(taskCtx).catch(error => {
                // Let's log the raw error *first* to see what it is
                console.error(">>> Raw error caught in streamingRunner:", error);

                const errorToHandle = error instanceof Error ? error : new Error(String(error)); // Wrap non-errors
                agentLogger.error(`Unhandled error in streaming agent execution`, errorToHandle, {
                    taskId: taskCtx.task.id
                });

                // Try to mark as failed through the streaming context
                try {
                    taskCtx.fail(errorToHandle);
                } catch (failError) {
                    agentLogger.error(`Failed to mark streaming task as failed`, failError);
                }
                // For debugging, let's forcefully exit here to prevent further propagation
                console.error(">>> Exiting due to unhandled stream error.");
                process.exit(1);
            });

            // Return immediately for streaming mode
            agentLogger.info(`Started streaming agent execution, returning control to client`);
            return;
        }

        // For non-streaming mode, await completion
        await plugin.handleTask(taskCtx);

        // Get buffered results if available
        if (!options.isStreaming && (taskCtx as any).getBufferedResults) {
            const results = (taskCtx as any).getBufferedResults();
            outputResults(results, options);
        }

        // Use base runner logger here for final success message
        logInfoMethod.call(runnerLogger, `Agent Execution Finished Successfully for Task ${taskCtx.task.id}`);
    } catch (error: unknown) {
        // Use agentLogger here for error
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
 * Set up listeners for streaming events
 */
function setupStreamListeners(taskId: string, options: StreamingOptions): void {
    const channel = taskChannel(taskId);

    // Determine log method for debug logs (debug -> stdout, warn -> stderr)
    const logDebugMethod = (options.outputType === 'json' || options.outputType === 'sse') ? runnerLogger.warn : runnerLogger.debug;

    // Add event listener for this task channel
    eventBus.subscribe(channel, (event: A2AEvent) => {
        if ('status' in event) {
            handleStatusEvent(event.status, event.final, options);
        } else if ('artifact' in event) {
            handleArtifactEvent(event.artifact, options);
        }
    });

    logDebugMethod.call(runnerLogger, `Set up event listeners for task channel: ${channel}`);
}

/**
 * Handle task status events
 */
function handleStatusEvent(status: TaskStatus, isFinal: boolean, options: StreamingOptions): void {
    const output = {
        type: 'status',
        status: status.state,
        timestamp: status.timestamp || new Date().toISOString(),
        final: isFinal,
        metadata: status.metadata ?? undefined // Include metadata if present
    };

    if (options.outputType === 'json') {
        // Pretty-print JSON status event
        const jsonOutput = JSON.stringify(output, null, 2);
        console.log(jsonOutput);

        // If outputFile is specified, append to file
        if (options.outputFile) {
            appendToFile(options.outputFile, jsonOutput + '\n');
        }
        return;
    } else if (options.outputType === 'sse') {
        const sseOutput = `data: ${JSON.stringify(output)}\n\n`;
        console.log(sseOutput);

        // If outputFile is specified, append to file
        if (options.outputFile) {
            appendToFile(options.outputFile, sseOutput);
        }
    } else {
        // Default console output
        if (isFinal) {
            console.log(`Status: ${status.state} (FINAL)`);
        } else if (status.state === 'working') {
            // Display progress messages for working states
            if (status.message?.parts) {
                const textParts = status.message.parts
                    .filter(part => part.type === 'text')
                    .map(part => (part as { text?: string }).text)
                    .filter(Boolean);

                if (textParts.length > 0) {
                    // Check if there's a progress percentage
                    const progressPercentage = status.metadata?.progress;
                    if (typeof progressPercentage === 'number') {
                        console.log(`Progress: ${progressPercentage}% - ${textParts.join(' ')}`);
                    } else {
                        console.log(`Progress: ${textParts.join(' ')}`);
                    }
                }
            } else {
                // Check if there's just a progress percentage without message
                const progressPercentage = status.metadata?.progress;
                if (typeof progressPercentage === 'number') {
                    console.log(`Progress: ${progressPercentage}%`);
                } else {
                    console.log(`Status: ${status.state}`);
                }
            }
        } else {
            console.log(`Status: ${status.state}`);
        }

        // If outputFile is specified, append to file in a human-readable format
        if (options.outputFile) {
            const statusText = isFinal ? `Status: ${status.state} (FINAL)` : `Status: ${status.state}`;
            appendToFile(options.outputFile, statusText + '\n');
        }
    }

    // If there's a message in the status, print it too (for non-console output types)
    if (status.message && status.message.parts && status.message.parts.length > 0 && options.outputType && options.outputType !== 'console') {
        const textParts = status.message.parts
            .filter(part => part.type === 'text')
            .map(part => (part as { text?: string }).text)
            .filter(Boolean);

        if (textParts.length > 0) {
            console.log(`Message: ${textParts.join('\n')}`);

            // If outputFile is specified, append to file
            if (options.outputFile) {
                appendToFile(options.outputFile, `Message: ${textParts.join('\n')}\n`);
            }
        }
    }
}

/**
 * Handle artifact events
 */
function handleArtifactEvent(artifact: Artifact, options: StreamingOptions): void {
    const output = {
        type: 'artifact',
        name: artifact.name || 'unnamed',
        index: artifact.index || 0,
        append: !!artifact.append,
        lastChunk: !!artifact.lastChunk
    };

    // Extract text content if available
    const textContent = artifact.parts && artifact.parts.length > 0
        ? artifact.parts
            .filter(part => part.type === 'text')
            .map(part => (part as { text?: string }).text)
            .filter(Boolean)
            .join('')
        : '';

    if (options.outputType === 'json') {
        // Pretty-print JSON artifact event
        const jsonPayload = { ...output, content: textContent };
        const jsonOutput = JSON.stringify(jsonPayload, null, 2);
        console.log(jsonOutput);

        // If outputFile is specified, append to file
        if (options.outputFile) {
            appendToFile(options.outputFile, jsonOutput + '\n');
        }
        return;
    } else if (options.outputType === 'sse') {
        const sseOutput = `data: ${JSON.stringify({
            ...output,
            content: textContent
        })}\n\n`;
        console.log(sseOutput);

        // If outputFile is specified, append to file
        if (options.outputFile) {
            appendToFile(options.outputFile, sseOutput);
        }
    } else {
        // Default console output - just print the text
        if (textContent) {
            console.log(textContent);

            // If outputFile is specified, append to file
            if (options.outputFile) {
                appendToFile(options.outputFile, textContent + '\n');
            }
        }
    }
}

/**
 * Output final results for non-streaming mode
 */
function outputResults(
    results: { status: TaskStatus | null; artifacts: Artifact[] },
    options: StreamingOptions
): void {
    if (options.outputType === 'json') {
        // Pretty-print the final JSON object
        const jsonOutput = JSON.stringify(results, null, 2);
        console.log(jsonOutput);

        // If outputFile is specified, append to file
        if (options.outputFile) {
            appendToFile(options.outputFile, jsonOutput + '\n');
        }
    } else {
        // Default console output
        if (results.status) {
            console.log(`Final Status: ${results.status.state}`);

            // If outputFile is specified, append to file
            if (options.outputFile) {
                appendToFile(options.outputFile, `Final Status: ${results.status.state}\n`);
            }
        }

        // Print artifacts
        for (const artifact of results.artifacts) {
            const textContent = artifact.parts && artifact.parts.length > 0
                ? artifact.parts
                    .filter(part => part.type === 'text')
                    .map(part => (part as { text?: string }).text)
                    .filter(Boolean)
                    .join('')
                : '';

            if (textContent) {
                const header = `\n--- ${artifact.name || 'Artifact'} ---`;
                console.log(header);
                console.log(textContent);

                // If outputFile is specified, append to file
                if (options.outputFile) {
                    appendToFile(options.outputFile, header + '\n' + textContent + '\n');
                }
            }
        }
    }
}

/**
 * Helper to append content to a file
 */
function appendToFile(filePath: string, content: string): void {
    try {
        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Append to file
        fs.appendFileSync(filePath, content, 'utf8');
    } catch (error) {
        runnerLogger.error(`Failed to write to output file`, error, { path: filePath });
    }
}

/**
 * Helper to pick only the named backends from all available
 * @param allBackends Map of all backend instances
 * @param names Array of backend names to include
 */
function pickBackends<T>(allBackends: Record<string, T>, names: string[]): Record<string, T> {
    return Object.fromEntries(Object.entries(allBackends).filter(([k]) => names.includes(k)));
}

/**
 * Set up listeners for progress events only (for non-streaming mode)
 */
function setupProgressListeners(taskId: string): void {
    const channel = taskChannel(taskId);

    // Add event listener for this task channel
    eventBus.subscribe(channel, (event: A2AEvent) => {
        if ('status' in event && event.status.state === 'working') {
            // Check for progress percentage first
            const progressPercentage = event.status.metadata?.progress;

            if (event.status.message?.parts) {
                // Display progress messages for working states
                const textParts = event.status.message.parts
                    .filter(part => part.type === 'text')
                    .map(part => (part as { text?: string }).text)
                    .filter(Boolean);

                if (textParts.length > 0) {
                    if (typeof progressPercentage === 'number') {
                        console.log(`Progress: ${progressPercentage}% - ${textParts.join(' ')}`);
                    } else {
                        console.log(`Progress: ${textParts.join(' ')}`);
                    }
                }
            } else if (typeof progressPercentage === 'number') {
                // Just show percentage if no message
                console.log(`Progress: ${progressPercentage}%`);
            }
        }

        // Unsubscribe when task is complete
        if ('status' in event && (event.status.state === 'completed' || event.status.state === 'failed')) {
            eventBus.unsubscribe(channel, setupProgressListeners);
        }
    });

    runnerLogger.debug(`Set up progress listeners for task channel: ${channel}`);
} 