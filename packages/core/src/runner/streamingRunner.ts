import path from 'node:path';
import { agentLoader } from './AgentLoader.js';
import { RunnerStateService } from './RunnerStateService.js';
import { ToolExecutionService } from './ToolExecutionService.js';
import { StreamTransport } from './StreamTransport.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, type MinimalConfig } from '../config/index.js';
import { PluginManager } from '../plugin/pluginManager.js';
import type { TaskContext, TaskInput, MessagePart } from '../shared/types/index.js';
import type { TaskStatus, Artifact as StreamArtifact } from '../shared/types/StreamingEvents.js';
import type { AgentPlugin } from '../plugin/types.js';
import { logger, withLoggingContext, type LoggerConfig } from '@a2arium/callagent-utils';
import { AgentError, InvariantError, ModuleExecutionError, TaskExecutionError } from '../utils/errors.js';
import type { InvariantErrorCode, InvariantErrorContext, InvariantErrorDetail } from '../types/invariantError.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { UniversalChatResponse, UniversalStreamResponse } from 'callllm';
import { createInMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import { createBusEvent, busEventData } from '../eventbus/busEventHelpers.js';
import type { BusEvent } from '../public-types/eventbus/schemas.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../context/StreamingContext.js';
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;
import type { A2AEvent, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '../shared/types/StreamingEvents.js';
import fs from 'node:fs';
import { createLLMForTask } from '../llm/LLMFactory.js';
import type { LLMMessage } from '../shared/types/LLMTypes.js';
import type { LLMCallOptions, LLMSettings } from '../types/llmContracts.js';
import { TaskEngine, type TaskEntity } from '../orchestration/taskEngine.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { registerHandler } from '../orchestration/HandlerRegistry.js';
import { createMemoryRegistry } from '@a2arium/callagent-memory-engine';
import { extendContextWithMemory } from '@a2arium/callagent-memory-engine';
import { resolveTenantId } from '../plugin/tenantResolver.js';
import { globalA2AService } from '../orchestration/A2AService.js';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { PrismaClient } from '../generated/prisma-client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { loadAgentIndexIfPresent } from '../plugin/AgentIndexLoader.js';
import { resolveActiveRunTimeout, resolveTerminalDrainTimeout } from './backgroundTaskTimeout.js';
import { readDurableTaskTerminal } from '../orchestration/TaskLifecycle.js';
import { createTerminalDeliveryGate } from './terminalDeliveryGate.js';
import {
    ArtifactStorageUnavailableError,
    createArtifactFactory,
} from '../context/artifactFactory.js';

// Create base runner logger
const runnerLogger = logger.createLogger({ prefix: 'StreamingRunner' });

// Detect if running in dev mode with ts-node. Library imports may not have argv[1].
const argv0 = process.argv[0] ?? '';
const argv1 = process.argv[1] ?? '';
const isDevMode = argv0.includes('ts-node') || argv1.includes('ts-node');

type StreamingOptions = {
    isStreaming: boolean;
    outputType?: 'json' | 'sse' | 'console';
    outputFile?: string;
    tenantId?: string; // CLI-specified tenant override
    resolveDeps?: boolean; // Whether to resolve dependencies (default: true)
    maxTurns?: number; // Override the default maxTurns
};

export type StreamingRunResult = {
    terminal: boolean;
    state?: TaskStatus['state'];
};

/**
 * Type for the partial context before memory extension
 * This excludes working memory methods that will be added by extendContextWithMemory
 */
type PartialTaskContext = Omit<TaskContext,
    'fail' | 'setGoal' | 'getGoal' | 'addThought' | 'getThoughts' |
    'makeDecision' | 'getDecision' | 'getAllDecisions' | 'vars' |
    'recall' | 'remember' | 'sendTaskToAgent' | 'requestInput' |
    'addGoal' | 'updateGoal' | 'moveGoal' | 'completeGoal' | 'failGoal' | 'listGoals'
>;

/**
 * Run an agent locally with the given input and streaming options
 * @param agentFilePath - Path to the agent module file
 * @param input - Input data for the agent
 * @param options - Streaming and output options
 * @throws {TaskExecutionError} If agent execution fails
 */
export async function runAgentWithStreamingDetailed(
    agentFilePath: string,
    input: TaskInput,
    options: StreamingOptions
): Promise<StreamingRunResult> {
    await loadAgentIndexIfPresent();

    const config: MinimalConfig = loadConfig();

    // Determine log method based on output format for runner logs
    const logTraceMethod = (options.outputType === 'json' || options.outputType === 'sse') ? runnerLogger.warn : runnerLogger.debug;

    // Use AgentLoader to resolve the plugin
    const plugin = await agentLoader.loadAgent(agentFilePath, {
        resolveDeps: options.resolveDeps
    });

    // Plugin is already registered in the unified registry via createAgent()

    const agentName = plugin.resolved.agentCard.name;
    const runMode = plugin.resolved.runtimeManifest.runMode || 'loop';

    // Resolve final tenant ID using hierarchy: CLI override → agent tenantId → env → default
    const explicitTenantId = options.tenantId || plugin.tenantId;
    const finalTenantId = resolveTenantId(explicitTenantId);

    // Use base runner logger here
    logTraceMethod.call(runnerLogger, `Running agent '${agentName}' (v${plugin.resolved.agentCard.version}) with streaming=${options.isStreaming} and tenant=${finalTenantId}`);

    // --- Create Task Context ---
    const taskId = `local-task-${Date.now()}`;
    const runnerEventBus = createInMemoryEventBus();

    // Initialize Services
    const runnerState = new RunnerStateService();
    const toolService = new ToolExecutionService();

    // Register local tools from llmConfig into the ToolExecutionService
    // so ctx.requestTool('toolName', ..., { awaitCompletion: true }) can find them
    const configTools = (plugin.llmConfig as any)?.tools || (plugin.llmConfig as any)?.initialTools;
    if (configTools && Array.isArray(configTools)) {
        for (const tool of configTools) {
            const fn = tool.invoke || tool.callFunction;
            if (tool.name && typeof fn === 'function') {
                toolService.register(tool.name, fn);
            }
        }
    }

    // Initialize stream transport
    const transport = new StreamTransport({
        outputType: options.outputType || 'console',
        outputFile: options.outputFile
    });

    // Set up event listeners for streaming output
    const channel = taskChannel(taskId);

    // Determine log method for debug logs (debug -> stdout, warn -> stderr)
    const logDebugMethod = (options.outputType === 'json' || options.outputType === 'sse') ? runnerLogger.warn : runnerLogger.debug;

    const terminalGate = createTerminalDeliveryGate((status) => transport.handleStatus(status, true));
    const deliverTerminal = (status: TaskStatus, deliveryKey: string): boolean =>
        terminalGate({ status, deliveryKey });
    const mainSubscription = await runnerEventBus.subscribe(channel, async (be: BusEvent) => {
        const event = busEventData<A2AEvent>(be);
        if (!event) {
            return;
        }
        if (options.isStreaming) {
            if ('status' in event) {
                const isTerminal = event.final === true && (
                    event.status.state === 'completed' ||
                    event.status.state === 'failed' ||
                    event.status.state === 'canceled'
                );
                const deliveryKey = (event as unknown as { deliveryKey?: string }).deliveryKey;
                if (isTerminal) {
                    if (deliveryKey || runMode === 'legacy') {
                        deliverTerminal(event.status, deliveryKey ?? `${taskId}:legacy:${event.status.state}`);
                    }
                } else {
                    transport.handleStatus(event.status, false);
                }
            } else if ('artifact' in event) {
                transport.handleArtifact(event.artifact);
            }
        } else {
            if ('status' in event && 'final' in event) {
                const s = event.status;
                const isFinal = (event as { final?: boolean }).final === true;
                if (
                    isFinal &&
                    (s.state === 'completed' || s.state === 'failed' || s.state === 'canceled')
                ) {
                    const deliveryKey = (event as unknown as { deliveryKey?: string }).deliveryKey;
                    if (deliveryKey || runMode === 'legacy') {
                        deliverTerminal(s, deliveryKey ?? `${taskId}:legacy:${s.state}`);
                    }
                } else if (s.state === 'input-required' || (s.state as unknown) === 'waiting_input') {
                    transport.handleStatus(s, false);
                } else if (s.state === 'working') {
                    transport.handleStatus(s, false);
                }
            }
        }
    });

    logDebugMethod.call(runnerLogger, `Set up event listeners for task channel: ${channel}`);

    // Create the agent-specific logger using the nested createLogger method
    const agentLogger = runnerLogger.createLogger({ prefix: agentName });

    // Create embedding function from LLMFactory
    const { createEmbeddingFunction, isEmbeddingAvailable } = await import('../llm/LLMFactory.js');
    const embeddingFunction = isEmbeddingAvailable() ? await createEmbeddingFunction() : undefined;

    // Get the memory registry instance with resolved tenant context
    const memoryRegistry = await createMemoryRegistry(finalTenantId, agentName, undefined, { embeddingFunction });
    const semanticAdapter = memoryRegistry.semantic.backends[config.memory.semantic.default];

    // Create cache service for agent result caching and artifact storage
    let agentResultCache: AgentResultCache | null = null;
    let agentResultCachePrisma: PrismaClient | null = null;
    const cacheEnabled = plugin.resolved.runtimeManifest.cache?.enabled === true;

    const ensureAgentResultCache = async (): Promise<AgentResultCache> => {
        if (agentResultCache) return agentResultCache;
        try {
            const dbUrl = process.env.MEMORY_DATABASE_URL;
            if (!dbUrl) throw new Error('MEMORY_DATABASE_URL is required for AgentResultCache');
            if (typeof dbUrl !== 'string') {
                throw new Error(`Invalid type for database URL in streamingRunner: expected string, received ${typeof dbUrl}`);
            }

            agentResultCachePrisma = new PrismaClient({
                adapter: new PrismaPg((await import('../pgStartupDiagnostic.js')).getSafePgConfig(dbUrl))
            }) as any;
            agentResultCache = new AgentResultCache(agentResultCachePrisma as any);
            return agentResultCache;
        } catch (error) {
            agentLogger.error('Failed to initialize AgentResultCache', error);
            throw new ArtifactStorageUnavailableError();
        }
    };

    if (cacheEnabled) {
        try {
            await ensureAgentResultCache();
            agentLogger.debug('Agent result cache initialized', {
                ttlSeconds: plugin.resolved.runtimeManifest.cache?.ttlSeconds,
                excludePaths: plugin.resolved.runtimeManifest.cache?.excludePaths
            });
        } catch (error) {
            agentLogger.error('Failed to initialize agent result cache, continuing without caching', error);
        }
    }

    // Create basic task context with resolved tenant information (excluding working memory methods)
    const artifactsFactory = createArtifactFactory({
        tenantId: finalTenantId,
        resolveCache: ensureAgentResultCache,
        onFailure: ({ operation, error, artifactId }) => {
            agentLogger.error('Artifact factory operation failed', {
                operation,
                tenantId: finalTenantId,
                taskId,
                agentId: agentName,
                artifactId,
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });

    const partialCtx: PartialTaskContext = {
        tenantId: finalTenantId,
        agentId: agentName,
        task: {
            id: taskId,
            input: input,
        },
        // These methods will be overridden by extendContextWithStreaming
        reply: async (parts: string | string[] | MessagePart | MessagePart[]) => {
            agentLogger.debug(`Agent Reply (stub - overridden by StreamingContext):`, { parts });
        },
        progress: (pctOrStatus: number | TaskStatus, msg?: string) => {
            if (typeof pctOrStatus === 'number') {
                agentLogger.debug(`Agent Progress: ${pctOrStatus}%${msg ? `: ${msg}` : ''}`);
            } else {
                // Handle TaskStatus object
                agentLogger.debug(`Agent Status: ${pctOrStatus.state}`, pctOrStatus);
            }
        },
        complete: (pct?: number, status?: string) => {
            agentLogger.debug(`Agent Complete: ${status || 'completed'} at ${pct ?? 100}%`);
        },
        artifacts: artifactsFactory,
        llm: plugin.llmAdapter || {
            async call<T = unknown>(message: LLMMessage, options?: LLMCallOptions): Promise<UniversalChatResponse<T>[]> {
                agentLogger.warn(`llm.call is stubbed (no LLM adapter configured)`, { message, options });
                return [{
                    content: "Stubbed LLM response - agent has no llmConfig",
                    role: "assistant"
                } as UniversalChatResponse<T>];
            },
            async *stream<T = unknown>(message: LLMMessage, options?: LLMCallOptions): AsyncIterable<UniversalStreamResponse<T>> {
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
            updateSettings(settings: LLMSettings): void {
                agentLogger.warn(`llm.updateSettings is stubbed (no LLM adapter configured)`, { settings });
            }
        },
        tools: toolService.asContextCapability(),
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
        updateStatus: (state: string): void => { agentLogger.debug(`Agent Status Update: -> ${state}`); },
        services: { get: <T = unknown>(name: string): T | undefined => { agentLogger.warn(`services.get is stubbed`, { name }); return undefined; } },
        getEnv: (key: string, defaultValue?: string): string | undefined => process.env[key] ?? defaultValue,
        throw: (code: InvariantErrorCode, message: string, detail: InvariantErrorDetail, context?: InvariantErrorContext): never => {
            agentLogger.error(`Agent threw structured error: [${code}] ${message}`, null, { detailType: detail.type });
            throwInvariantError(code, message, detail, context);
        },
        recordUsage: (usage: unknown): void => {
            agentLogger.warn('recordUsage is stubbed in local runner', { usage });
        },
        memory: memoryRegistry,
        requestTool: async (toolName: string, args: unknown, opts?: { awaitCompletion?: boolean; onCompleted?: string }) => {
            if (opts?.awaitCompletion === true) {
                // Delegate to the local tool service for synchronous execution
                return toolService.asContextCapability().invoke(toolName, args);
            }
            // Async tool requests are not fully supported in local runner (no durable session)
            agentLogger.warn('requestTool: async mode is not fully supported in local runner; returning stub token', { toolName });
            return { token: `local-stub-${Date.now()}` } as any;
        }
    };

    // Replace the LLM stub with a real implementation BEFORE creating memory registry
    if (!plugin.llmAdapter && plugin.llmConfig) {
        logTraceMethod.call(runnerLogger, `Creating LLM using factory for plugin ${plugin.resolved.agentCard.name}`, {
            provider: plugin.llmConfig.provider,
            model: plugin.llmConfig.modelAliasOrName
        });
        try {
            partialCtx.llm = createLLMForTask(plugin.llmConfig, partialCtx as any);
            logTraceMethod.call(runnerLogger, `LLM created successfully for plugin ${plugin.resolved.agentCard.name}`);
        } catch (error) {
            logTraceMethod.call(runnerLogger, `Failed to create LLM for plugin ${plugin.resolved.agentCard.name}`, { error: error instanceof Error ? error.message : String(error) });
            // Keep the stub LLM that was already assigned
        }
    } else if (!plugin.llmAdapter) {
        logTraceMethod.call(runnerLogger, `Not creating LLM - plugin ${plugin.resolved.agentCard.name} has no config`, {
            hasAdapter: !!plugin.llmAdapter,
            hasConfig: !!plugin.llmConfig
        });
    }

    // Extend context with MLO-backed memory operations (now with real LLM)
    const contextWithMemory = await extendContextWithMemory(
        partialCtx,
        finalTenantId,
        agentName,
        plugin.resolved.runtimeManifest, // Agent config for memory profile
        semanticAdapter, // Existing semantic adapter for backward compatibility
        await (await import('@a2arium/callagent-memory-engine')).getMemoryPrismaClient()
    );

    // memory registry constructed

    // A2A + conversation bootstrap: delegate to TaskEngine when registered (parity with ApiBinder path)
    const engine = EngineLocator.getEngine<TaskEngine>();
    const coreCtx = contextWithMemory as unknown as TaskContext;
    const streamingSend = engine?.createStreamingSendTaskToAgent(coreCtx);
    coreCtx.sendTaskToAgent = (
        streamingSend ??
        ((targetAgent: string, taskInput: TaskInput, options?: import('../shared/types/A2ATypes.js').A2ACallOptions) =>
            globalA2AService.sendTaskToAgent(coreCtx, targetAgent, taskInput, options))
    ) as TaskContext['sendTaskToAgent'];

    // The context is now complete - no need for type assertion
    const taskCtx: TaskContext = {
        ...contextWithMemory,
        // propagate runMode for TaskEngine
        ...(runMode ? { runMode } as any : {}),
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
    extendContextWithStreaming(taskCtx, options.isStreaming, runnerEventBus);

    // --- Check Cache Before Agent Execution ---
    if (cacheEnabled) {
        try {
            const cache = await ensureAgentResultCache();
            const cachedResult = await cache.getCachedResult(
                plugin.resolved.agentCard.name,
                input,
                plugin.resolved.runtimeManifest.cache?.excludePaths || [],
                finalTenantId
            );

            if (cachedResult) {
                agentLogger.info(`Cache hit - returning cached result for agent ${plugin.resolved.agentCard.name}`);

                if (options.isStreaming) {
                    try {
                        await taskCtx.reply([{
                            type: 'text',
                            text: typeof cachedResult === 'string' ? cachedResult : JSON.stringify(cachedResult)
                        }]);
                        const finalStatus: TaskStatus = {
                            state: 'completed',
                            timestamp: new Date().toISOString(),
                            metadata: { source: 'cache', usage: { totalCost: 0, byKind: {} } }
                        } as any;
                        deliverTerminal(finalStatus, `${taskId}:terminal:cache`);
                        try {
                            void runnerEventBus.publish(
                                createBusEvent({
                                    channel: taskChannel(taskId),
                                    partitionKey: taskId,
                                    cloud: {
                                        id: uuidv7(),
                                        type: 'task.a2a',
                                        source: `/tasks/${taskId}`,
                                        time: new Date().toISOString(),
                                        datacontenttype: 'application/json',
                                    data: {
                                        id: taskId,
                                        status: finalStatus,
                                        final: true,
                                        deliveryKey: `${taskId}:terminal:cache`,
                                    },
                                    },
                                })
                            );
                        } catch {
                            /* noop */
                        }
                    } catch (error) {
                        agentLogger.error('Failed to replay cached result in streaming mode', error);
                        await taskCtx.fail(error);
                    }
                } else {
                    const results = {
                        status: {
                            state: 'completed' as const,
                            timestamp: new Date().toISOString(),
                            metadata: { source: 'cache', usage: { totalCost: 0, byKind: {} } }
                        },
                        artifacts: [{
                            id: 'cached-response',
                            type: 'text' as const,
                            title: 'Cached Response',
                            parts: [{
                                type: 'text' as const,
                                text: typeof cachedResult === 'string' ? cachedResult : JSON.stringify(cachedResult, null, 2)
                            }]
                        }]
                    };

                    // Use transport to output results
                    if (results.status) {
                        deliverTerminal(results.status as any, `${taskId}:terminal:cache`);
                    }
                    for (const artifact of results.artifacts) {
                        transport.handleArtifact(artifact);
                    }

                    logTraceMethod.call(runnerLogger, `Agent Execution Completed (from cache) for Task ${taskCtx.task.id}`);
                }
                await mainSubscription.unsubscribe().catch(() => undefined);
                const cachePrisma = agentResultCachePrisma as PrismaClient | null;
                if (cachePrisma?.$disconnect) {
                    await cachePrisma.$disconnect().catch(() => undefined);
                }
                await import('@a2arium/callagent-memory-engine')
                    .then((memory) => memory.disconnectMemoryPrismaClient())
                    .catch(() => undefined);
                return { terminal: true, state: 'completed' };
            }
        } catch (error) {
            agentLogger.error('Result cache lookup failed', error);
        }
    }

    // --- Execute via Task Engine ---
    agentLogger.info(`Starting Engine Execution for Task ${taskCtx.task.id}`);

    // Establish logging context for entire task execution
    return withLoggingContext(
        {
            taskId: taskCtx.task.id,
            tenantId: finalTenantId,
            agentId: agentName,
            correlationId: `corr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        },
        async () => {
            let cleanupExecution: (() => Promise<void>) | undefined;
            try {
                // Register durable handlers from the module
                try {
                    const moduleUrl = pathToFileURL(agentFilePath).href;
                    const mod: Record<string, unknown> = await import(moduleUrl);
                    // Always register default handleTask from the loaded plugin
                    if (plugin.handleTask) {
                        registerHandler('handleTask', async (ctx: any) => {
                            runnerLogger.info(`Invoking durable handler: handleTask`, { taskId: ctx?.task?.id });
                            await plugin.handleTask!(ctx);
                        });
                    }
                    for (const [name, fn] of Object.entries(mod)) {
                        if (name === 'default') continue;
                        if (typeof fn === 'function') {
                            runnerLogger.info(`Registering durable handler: ${name}`);
                            registerHandler(name, async (ctx: any, ev: any) => (fn as any)(ctx, ev));
                        }
                    }
                    runnerLogger.info(`Handler registration completed`);
                } catch (e) {
                    agentLogger.warn('Handler auto-registration failed', e as any);
                }

                const sessionStore = new WorkingMemorySessionStore();
                await sessionStore.connect();
                const engine = new TaskEngine({ sessionStore, eventBus: runnerEventBus });
                let cleanedUp = false;
                const cleanup = async (): Promise<void> => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    await mainSubscription.unsubscribe().catch(() => undefined);
                    try { await globalA2AService.waitForPendingNotifications(); } catch (err) {
                        runnerLogger.warn('Failed waiting for pending A2A notifications', {
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                    try { engine.stopOutboxPublisher(); } catch { /* noop */ }
                    try { await engine.closeTransportAdapters(); } catch { /* noop */ }
                    try { await sessionStore.close(); } catch { /* noop */ }
                    try { EngineLocator.setEngine(null as any); } catch { /* noop */ }
                    if (agentResultCachePrisma?.$disconnect) {
                        try { await agentResultCachePrisma.$disconnect(); } catch { /* noop */ }
                    }
                    try { await (globalA2AService as any)?.agentResultCache?.prisma?.$disconnect?.(); } catch { /* noop */ }
                    try { await (await import('@a2arium/callagent-memory-engine')).disconnectMemoryPrismaClient(); } catch { /* noop */ }
                };
                cleanupExecution = cleanup;
                try { EngineLocator.setEngine(engine as any); } catch { }
                const entity: TaskEntity = { id: taskCtx.task.id, input };
                runnerLogger.info(`Starting TaskEngine.startTask`, { taskId: entity.id, streaming: options.isStreaming });
                const wmCap = process.env.WM_SNAPSHOT_MAX_BYTES;
                if (wmCap) {
                    runnerLogger.info(`WM snapshot cap configured`, { WM_SNAPSHOT_MAX_BYTES: wmCap });
                }
                const runStartedAtMs = Date.now();
                const activeRun = resolveActiveRunTimeout({
                    explicitTimeoutMs: process.env.CALLAGENT_ACTIVE_RUN_TIMEOUT_MS,
                    realRunTimeoutMs: process.env.REAL_RUN_TIMEOUT_MS,
                    latencyBudgetMs: plugin.resolved.runtimeManifest.budgets?.latencyMs,
                });
                const terminalDrain = resolveTerminalDrainTimeout(
                    process.env.CALLAGENT_BACKGROUND_TASK_TIMEOUT_MS
                );
                const returnedTask = await engine.startTask({ task: entity, isStreaming: options.isStreaming, agentId: agentName, tenantId: finalTenantId, initialContext: taskCtx, options: { maxTurns: options.maxTurns } });
                let authoritativeStatus = returnedTask?.status;
                if (
                    authoritativeStatus === undefined ||
                    authoritativeStatus.state === 'submitted' ||
                    authoritativeStatus.state === 'working'
                ) {
                    runnerLogger.info('Waiting for durable root terminality', {
                        taskId: taskCtx.task.id,
                        timeoutMs: activeRun.timeoutMs,
                        source: activeRun.source,
                    });
                    const observed = await engine.awaitTaskTerminal({
                        tenantId: finalTenantId,
                        taskId: taskCtx.task.id,
                        agentId: agentName,
                        timeoutMs: activeRun.timeoutMs,
                        timeoutSource: activeRun.source,
                        startedAtMs: runStartedAtMs,
                    });
                    authoritativeStatus = observed.status;
                    if (returnedTask !== undefined) returnedTask.status = authoritativeStatus;
                }

                const durableSnapshot = await sessionStore.getSessionSnapshot(finalTenantId, taskCtx.task.id);
                const durableTerminal = readDurableTaskTerminal(durableSnapshot?.snapshot);
                if (durableTerminal !== undefined) {
                    authoritativeStatus = durableTerminal.status as TaskStatus;
                    if (returnedTask !== undefined) returnedTask.status = authoritativeStatus;
                    deliverTerminal(authoritativeStatus, durableTerminal.deliveryKey);
                    if (cacheEnabled && authoritativeStatus.state === 'completed') {
                        const resultToCache = authoritativeStatus.metadata?.result;
                        if (resultToCache !== undefined) {
                            try {
                                const cache = await ensureAgentResultCache();
                                await cache.setCachedResult(
                                    plugin.resolved.agentCard.name,
                                    input,
                                    resultToCache,
                                    plugin.resolved.runtimeManifest.cache?.ttlSeconds || 300,
                                    plugin.resolved.runtimeManifest.cache?.excludePaths || [],
                                    finalTenantId
                                );
                            } catch (error) {
                                agentLogger.error('Failed to cache durable agent result', error);
                            }
                        }
                    }
                }

                const isTerminal = authoritativeStatus?.state === 'completed' ||
                    authoritativeStatus?.state === 'failed' ||
                    authoritativeStatus?.state === 'canceled';
                if (isTerminal) {
                    runnerLogger.info('Draining terminal root cleanup', {
                        taskId: taskCtx.task.id,
                        timeoutMs: terminalDrain.timeoutMs,
                        source: terminalDrain.source,
                        taskState: authoritativeStatus?.state,
                    });
                    const drainReport = await engine.drainBackgroundTasks({
                        rootTaskId: taskCtx.task.id,
                        timeoutMs: terminalDrain.timeoutMs,
                        throwOnTimeout: false,
                    });
                    if (drainReport.detachedCount > 0 || drainReport.activeCount > 0) {
                        runnerLogger.warn('Terminal result preserved with background cleanup diagnostics', {
                            taskId: taskCtx.task.id,
                            detachedCount: drainReport.detachedCount,
                            activeCount: drainReport.activeCount,
                            remainingTasks: drainReport.remainingTasks,
                        });
                    }
                }

                if (authoritativeStatus?.state === 'failed' || authoritativeStatus?.state === 'canceled') {
                    if (durableTerminal === undefined) {
                        deliverTerminal(
                            authoritativeStatus,
                            `${taskCtx.task.id}:terminal:${authoritativeStatus.state}`
                        );
                    }
                    await cleanup();
                    const reason = typeof authoritativeStatus.metadata?.reason === 'string'
                        ? authoritativeStatus.metadata.reason
                        : (authoritativeStatus.message?.parts?.find(p => p.type === 'text') as any)?.text ||
                          (authoritativeStatus.state === 'failed' ? 'Task execution failed' : 'Task canceled');
                    throw new AgentError(reason, agentName, {
                        taskId: taskCtx.task.id,
                        terminalStatusPreserved: true,
                    });
                }
                logTraceMethod.call(runnerLogger, `Engine Execution started for Task ${taskCtx.task.id}`);
                if (isTerminal || !options.isStreaming) {
                    logTraceMethod.call(runnerLogger, `Engine Execution Finished Successfully for Task ${taskCtx.task.id}`);
                    await cleanup();
                }
                return {
                    terminal: isTerminal,
                    ...(authoritativeStatus?.state ? { state: authoritativeStatus.state } : {}),
                };
            } catch (error: unknown) {
                await cleanupExecution?.().catch(() => undefined);
                // Use agentLogger here for error
                agentLogger.error(`Unhandled Agent Execution Error`, error, {
                    taskId: taskCtx.task.id
                });

                const terminalStatusPreserved =
                    error instanceof AgentError && error.details?.terminalStatusPreserved === true;
                if (!terminalStatusPreserved) {
                    try {
                        if (taskCtx.fail) {
                            await taskCtx.fail(new Error('Unhandled exception during task execution'));
                        } else {
                            taskCtx.complete(100, 'failed_unhandled');
                        }
                    } catch { /* ignore double failure */ }
                }

                if (error instanceof InvariantError || error instanceof ModuleExecutionError) {
                    throw error;
                }
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
        }); // End of withLoggingContext
}

/** Public compatibility wrapper. CLI callers use the detailed result internally. */
export async function runAgentWithStreaming(
    agentFilePath: string,
    input: TaskInput,
    options: StreamingOptions
): Promise<void> {
    await runAgentWithStreamingDetailed(agentFilePath, input, options);
}




/**
 * Handle task status events
 */


/**
 * Handle artifact events
 */
function handleArtifactEvent(artifact: StreamArtifact, options: StreamingOptions): void {
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
    results: { status: TaskStatus | null; artifacts: StreamArtifact[] },
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
function setupProgressListeners(taskId: string, bus: IEventBus): void {
    const channel = taskChannel(taskId);
    void bus.subscribe(channel, async (be: BusEvent) => {
        const event = busEventData<A2AEvent>(be);
        if (!event || !('status' in event)) {
            return;
        }
        if ('status' in event) {
            const s = event.status;
            if (s.state === 'input-required' || (s.state as unknown) === 'waiting_input') {
                console.log(`Status: waiting_input`);
                const promptText = s.message?.parts
                    ?.filter(part => part.type === 'text')
                    .map(part => (part as { text?: string }).text)
                    .filter(Boolean)
                    .join(' ');
                if (promptText) console.log(`Prompt: ${promptText}`);
                const token = (s as { metadata?: { token?: string } }).metadata?.token;
                if (token) console.log(`Token: ${token}`);
                console.log(`Session: ${event.id}`);
            } else if (s.state === 'working') {
                const progressPercentage = s.metadata?.progress;
                if (s.message?.parts) {
                    const textParts = s.message.parts
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
                    console.log(`Progress: ${progressPercentage}%`);
                }
            }
        }
    });
    runnerLogger.debug(`Set up progress listeners for task channel: ${channel}`);
}
