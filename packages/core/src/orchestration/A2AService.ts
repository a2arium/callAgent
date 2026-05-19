
import type { TaskInput, TaskContext as FullTaskContext } from '../shared/types/index.js'; // Full TaskContext for target
import {
    SerializedAgentContext
} from '@a2arium/callagent-memory-engine';
import type {
    MinimalSourceTaskContext,
    A2ACallOptions,
    InteractiveTaskResult,
    IA2AService
} from '../shared/types/A2ATypes.js';
import type { AgentPlugin } from '../plugin/types.js';
import { ContextSerializer } from './ContextSerializer.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { extendContextWithMemory } from '@a2arium/callagent-memory-engine';
import { InteractiveTaskHandler } from './InteractiveTaskResult.js';
import { logger, withLoggingContext } from '@a2arium/callagent-utils';
import { createLLMForTask } from '../llm/LLMFactory.js';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { EngineLocator } from './EngineLocator.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { getPendingInputs, setPendingInputs } from './DurableHandlerRegistry.js';
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import type { TaskEngine } from './taskEngine.js';
import { ArtifactHydrationService } from './ArtifactHydrationService.js';
import { getCallChainTracker, type CallChainTracker } from './CallChainTracker.js';
import { AgentNode } from '../telemetry/nodes/AgentNode.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { attachA2aResultTelemetry } from './api/a2aResultTelemetry.js';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamMessagePart,
} from '../streaming/runtimeStreamEvents.js';

const a2aLogger = logger.createLogger({ prefix: 'A2AService' });

function getRequiredEngine(): TaskEngine {
    const engine = EngineLocator.getEngine<TaskEngine>();
    if (!engine) {
        throw new Error(
            '[A2AService] TaskEngine is not registered. Call EngineLocator.setEngine(...) with a configured TaskEngine before using agent-to-agent workflows.'
        );
    }
    return engine;
}

/**
 * Service for agent-to-agent communication
 * Handles local agent discovery, context transfer, and task execution
 */

const log = logger.createLogger({ prefix: 'A2AService' });

export class A2AService implements IA2AService {
    private agentResultCache: AgentResultCache | null = null;
    private readonly pendingNotifications: Set<Promise<void>> = new Set();
    private readonly callChainTracker: CallChainTracker;

    constructor(
        private eventBus?: any // Future: for interactive communication
    ) {
        // Initialize cache service
        this.initializeCacheService().catch(error => {
            a2aLogger.error('Failed to initialize A2A cache service', error);
        });

        // Initialize call chain tracker with config from environment
        const maxDepth = process.env.MAX_AGENT_DEPTH ? parseInt(process.env.MAX_AGENT_DEPTH, 10) : undefined;
        this.callChainTracker = getCallChainTracker({
            maxDepth,
            enableCycleDetection: process.env.ENABLE_CYCLE_DETECTION !== 'false',
            enableDepthLimiting: process.env.ENABLE_DEPTH_LIMITING !== 'false',
            warnOnlyInDevelopment: process.env.NODE_ENV === 'development' && process.env.CYCLE_WARN_ONLY === 'true'
        });
    }

    private async initializeCacheService(): Promise<void> {
        try {
            const { PrismaClient } = await import('../generated/prisma-client/index.js');
            const { PrismaPg } = await import('@prisma/adapter-pg');
            const pg = (await import('pg')).default;

            const dbUrl = process.env.MEMORY_DATABASE_URL;
            if (dbUrl) {
                if (typeof dbUrl !== 'string') {
                    throw new Error(`Invalid type for MEMORY_DATABASE_URL: expected string, received ${typeof dbUrl}`);
                }
                const { getSafePgConfig } = await import('../pgStartupDiagnostic.js');
                const config = getSafePgConfig(dbUrl);
                const adapter = new PrismaPg(config);
                const prisma = new PrismaClient({ adapter }) as any;
                this.agentResultCache = new AgentResultCache(prisma);
                a2aLogger.debug('A2A cache service initialized successfully');
            } else {
                a2aLogger.warn('MEMORY_DATABASE_URL not found, A2A cache service will not be available');
            }
        } catch (error) {
            a2aLogger.error('A2A cache service initialization failed, continuing without caching', error);
        }
    }

    private trackNotification(promise: Promise<void>): void {
        this.pendingNotifications.add(promise);
        promise.finally(() => {
            this.pendingNotifications.delete(promise);
        }).catch(() => {
            // Ignored: the original promise already logged the error
        });
    }

    async waitForPendingNotifications(): Promise<void> {
        while (this.pendingNotifications.size > 0) {
            const pending = Array.from(this.pendingNotifications);
            await Promise.allSettled(pending);
            // Yield to allow any follow-up notifications enqueued during await to register
            if (this.pendingNotifications.size > 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
    }

    /**
     * Send task to another agent with context inheritance
     */
    async sendTaskToAgent(
        sourceCtx: MinimalSourceTaskContext, // Use MinimalSourceTaskContext
        targetAgent: string,
        taskInput: TaskInput,
        options: A2ACallOptions & { parentTenantId?: string; parentTaskId?: string; parentChildToken?: string; parentTelemetryNodeId?: string } = {}
    ): Promise<InteractiveTaskResult | unknown> {
        const startTime = Date.now();
        const operationId = `a2a_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        a2aLogger.debug('A2A task initiated', {
            operationId,
            sourceTaskId: sourceCtx.task.id,
            sourceAgentId: sourceCtx.agentId,
            targetAgent,
            tenantId: options.tenantId || sourceCtx.tenantId,
            options
        });

        // ✅ CIRCULAR DEPENDENCY DETECTION
        // Check if spawning this agent would create a circular dependency or exceed max depth
        const cycleCheck = this.callChainTracker.checkCircularDependency(
            targetAgent,
            sourceCtx.task.id
        );

        if (cycleCheck.hasCycle) {
            const chain = cycleCheck.chain.map(c => c.agentId).join(' → ');
            const errorMessage =
                `CIRCULAR DEPENDENCY DETECTED:\n` +
                `  Attempting to spawn: ${targetAgent}\n` +
                `  Agent chain: ${chain} → ${targetAgent}\n` +
                `  This would create infinite recursion.\n` +
                `  \n` +
                `  Solution options:\n` +
                `  1. Refactor to break the cycle (e.g., use a third orchestrator agent)\n` +
                `  2. Make one of the agents complete without calling the other\n` +
                `  3. Use explicit childTaskId and handle resumption manually\n` +
                `  \n` +
                `  Full call chain:\n${this.callChainTracker.formatCallChain(sourceCtx.task.id)}`;

            a2aLogger.error('Circular dependency detected', {
                targetAgent,
                chain,
                sourceTaskId: sourceCtx.task.id
            });

            throw new Error(errorMessage);
        }

        if (cycleCheck.exceedsMaxDepth) {
            const chain = cycleCheck.chain.map(c => c.agentId).join(' → ');
            const maxDepth = (this.callChainTracker as any).config?.maxDepth || 20;
            const errorMessage =
                `MAXIMUM AGENT DEPTH EXCEEDED (${maxDepth}):\n` +
                `  Attempting to spawn: ${targetAgent}\n` +
                `  Current depth: ${cycleCheck.depth}\n` +
                `  Agent chain: ${chain}\n` +
                `  \n` +
                `  This may indicate infinite recursion or overly deep agent nesting.\n` +
                `  \n` +
                `  Solution options:\n` +
                `  1. Refactor to reduce agent nesting depth\n` +
                `  2. Increase MAX_AGENT_DEPTH environment variable if this is expected\n` +
                `  3. Use explicit childTaskId for manual resumption\n` +
                `  \n` +
                `  Full call chain:\n${this.callChainTracker.formatCallChain(sourceCtx.task.id)}`;

            a2aLogger.error('Maximum agent depth exceeded', {
                targetAgent,
                depth: cycleCheck.depth,
                maxDepth,
                chain
            });

            throw new Error(errorMessage);
        }

        try {
            // 1. Discover target agent
            const targetPlugin = await this.findLocalAgent(targetAgent);
            if (!targetPlugin) {
                const available = PluginManager.listAgents().map(a => a.name);
                const hint = `Local agent not found: '${targetAgent}'. ` +
                    `Agent discovery tries: (1) registry (loaded via inline manifest), (2) same-folder using the calling agent's path, ` +
                    `(3) workspaces from package.json, (4) smart filesystem scan for '*Agent.(ts|js)' or agent.json. ` +
                    `Currently loaded agents: ${available.length ? available.join(', ') : '(none)'}`;
                throw new Error(hint);
            }

            // 2. Serialize source context
            const serializedContext = await ContextSerializer.serializeContext(sourceCtx, options);

            // 3. Create target context and deserialize with sanitized logging metadata
            // This prevents "blink" effect where parent turn leaks into child initialization logs
            const { targetCtx, serializedContext: _ } = await withLoggingContext({ turn: undefined }, async () => {
                const targetCtx = await this.createTargetContext(
                    sourceCtx,
                    targetPlugin,
                    taskInput,
                    serializedContext,
                    options
                );
                await ContextSerializer.deserializeContext(targetCtx, serializedContext);
                return { targetCtx, serializedContext };
            });

            // 4. Register this call in the chain tracker
            const parentDepth = this.callChainTracker.getCallChain(sourceCtx.task.id).length;
            this.callChainTracker.registerCall({
                taskId: targetCtx.task.id,
                agentId: targetAgent,
                parentTaskId: sourceCtx.task.id,
                depth: parentDepth + 1,
                timestamp: Date.now()
            });

            // 5. Execute target agent via TaskEngine for WM/LLM persistence
            const eng = getRequiredEngine();
            // Attach WM and orchestration APIs for child session
            try {
                const attach = (eng as unknown as { attachWorkingMemory?: (ctx: typeof targetCtx, tenantId: string, sessionId: string, agentId: string) => Promise<void> }).attachWorkingMemory;
                if (attach) await attach(targetCtx, targetCtx.tenantId, targetCtx.task.id, targetPlugin.resolved.agentCard.name);
            } catch { }

            const execOptions = {
                ...options,
                parentTelemetryNodeId:
                    options.parentTelemetryNodeId ?? sourceCtx.telemetry?.nodeId,
            };

            let result;
            try {
                result = await this.executeTargetAgent(targetPlugin, targetCtx, operationId, execOptions);
            } finally {
                // Unregister when complete (even if error)
                this.callChainTracker.unregisterCall(targetCtx.task.id);
            }

            // If child signaled input_required via targetCtx flag, route to parent and do not treat as completed
            if ((targetCtx as any).__inputRequired && options.parentTenantId && options.parentTaskId && options.parentChildToken) {
                // Guard: blocking await with non-terminal (input_required) is unsupported
                if ((options as any)?.awaitCompletion === true) {
                    const childName = targetPlugin.resolved.agentCard.name;
                    throw new Error(
                        `Child agent '${childName}' requested await_input while parent awaited completion. ` +
                        `This is not supported for awaitCompletion=true. Fix by either: ` +
                        `make the child complete in one turn for this path, or call with awaitCompletion=false and propagate await_child from the parent.`
                    );
                }
                const eng = getRequiredEngine();
                const { prompt, schema, childOnProvided, childTaskId } = (targetCtx as any).__inputRequired as { prompt: string; schema?: unknown; childOnProvided?: string; childTaskId?: string };
                try { log.debug('Post-turn child input_required routing to parent', { childOnProvided, childTaskId, prompt }); } catch { }
                await eng.handleChildInputRequired({
                    tenantId: options.parentTenantId,
                    parentTaskId: options.parentTaskId,
                    childToken: options.parentChildToken,
                    childTaskId,
                    prompt,
                    schema,
                    childOnProvided
                });
                return { status: 'input_required' } as any;
            }

            // Guard: blocking await with non-terminal (input_required) is unsupported
            const resultStatus = (result as any)?.status;
            const isInputRequired = resultStatus === 'input_required' || (resultStatus && (resultStatus as any).state === 'input-required');
            if (isInputRequired && (options as any)?.awaitCompletion === true) {
                const msg = [
                    `Child agent '${targetPlugin.resolved.agentCard.name}' returned await_input while parent awaited completion.`,
                    `This is not supported for awaitCompletion=true.`,
                    `Fix by either:`,
                    `- Making the child return 'complete' in one turn for this path (blocking).`,
                    `- Or call with awaitCompletion=false and propagate await_child from the parent.`,
                ].join(' ');
                throw new Error(msg);
            }

            const duration = Date.now() - startTime;
            a2aLogger.debug('A2A task completed', {
                operationId,
                duration,
                success: true
            });

            // Notify parent engine on completion when correlation is provided
            const skipNotification = (options as any).skipParentNotification;
            a2aLogger.debug('🔍 A2A: Checking if should notify parent', {
                hasParentTenantId: !!options.parentTenantId,
                hasParentTaskId: !!options.parentTaskId,
                hasParentChildToken: !!options.parentChildToken,
                parentTaskId: options.parentTaskId,
                parentChildToken: options.parentChildToken,
                awaitCompletion: (options as any).awaitCompletion,
                skipParentNotification: skipNotification
            });
            if (options.parentTenantId && options.parentTaskId && options.parentChildToken && !skipNotification) {
                const deliverCompletion = async () => {
                    await eng.handleChildCompleted({
                        tenantId: options.parentTenantId!,
                        parentTaskId: options.parentTaskId!,
                        childToken: options.parentChildToken!,
                        result,
                        childAgentId: targetPlugin.resolved.agentCard.name
                    });
                };

                // ✅ FIX: Check if awaitCompletion is false (now explicitly passed from taskEngine)
                // The awaitCompletion value is determined in taskEngine before calling sendTaskToAgent
                // and passed in a2aOptions, so it should be in options here
                const awaitCompletionValue = (options as any).awaitCompletion;
                a2aLogger.debug('🔍 A2A: Checking awaitCompletion for staging', {
                    parentTaskId: options.parentTaskId,
                    childToken: options.parentChildToken,
                    awaitCompletionValue,
                    awaitCompletionType: typeof awaitCompletionValue,
                    shouldStage: awaitCompletionValue === false
                });
                if (awaitCompletionValue === false) {
                    // ✅ FIX: Check if active loop already handles this via ApiBinder sync injection
                    // If so, we MUST NOT trigger handleChildCompleted, as it would restart the task (Phantom Restart)
                    const hasActiveLoopInbox = !!(sourceCtx as any)?.__activeLoopInbox;

                    if (hasActiveLoopInbox) {
                        a2aLogger.info('Skipping child completion notification - active loop handles via inbox injection', {
                            parentTaskId: options.parentTaskId,
                            childToken: options.parentChildToken
                        });
                        // Do nothing - ApiBinder logic took care of it
                    } else {
                        // Original behavior: Stage synchronously + defer notification
                        // ✅ FIX: Stage observation synchronously BEFORE deferring resume
                        // This ensures the observation is available when the parent resumes, even for synchronous completions
                        a2aLogger.debug('Staging child completion observation synchronously', {
                            parentTaskId: options.parentTaskId,
                            childToken: options.parentChildToken
                        });
                        try {
                            await eng.stageChildCompletionObservation({
                                tenantId: options.parentTenantId!,
                                parentTaskId: options.parentTaskId!,
                                childToken: options.parentChildToken!,
                                result,
                                childAgentId: targetPlugin.resolved.agentCard.name
                            });
                            a2aLogger.debug('Successfully staged child completion observation', {
                                parentTaskId: options.parentTaskId,
                                childToken: options.parentChildToken
                            });
                        } catch (stageError) {
                            a2aLogger.warn('Failed to stage child completion observation synchronously', {
                                error: stageError instanceof Error ? stageError.message : String(stageError),
                                parentTaskId: options.parentTaskId
                            });
                        }

                        // Defer the resume to next turn to ensure observation is available
                        queueMicrotask(() => {
                            const notifyPromise = deliverCompletion().catch(notifyError => {
                                a2aLogger.error('Failed to notify parent on child completion (deferred)', notifyError as any, {
                                    parentTaskId: options.parentTaskId
                                });
                            });
                            this.trackNotification(notifyPromise);
                        });
                    }
                } else {
                    try {
                        await deliverCompletion();
                    } catch (notifyError) {
                        a2aLogger.error('Failed to notify parent on child completion', notifyError as any, {
                            parentTaskId: options.parentTaskId
                        });
                    }
                }
            }

            // Flush child snapshot (vars + llm) after turn (avoid duplicate if already saved during requestInput turn)
            try {
                if (!(targetCtx as any).__wmSavedThisTurn) {
                    await (eng as any).flushContextSnapshot?.(targetCtx.tenantId, targetCtx.task.id, targetPlugin.resolved.agentCard.name, targetCtx as any);
                }
            } catch { }

            return result;

        } catch (error) {
            const duration = Date.now() - startTime;
            a2aLogger.error('A2A task failed', error, {
                operationId,
                duration,
                targetAgent
            });
            throw error;
        }
    }

    /**
     * Build a TaskContext for a thread-bound session (no parent A2A call, no child task id randomization).
     * Used by conversation recipient activation: task id equals routing session id `${threadId}:${agentId}`.
     */
    async buildPassiveConversationContext(params: {
        plugin: AgentPlugin;
        tenantId: string;
        sessionId: string;
    }): Promise<FullTaskContext> {
        const { plugin, tenantId, sessionId } = params;
        const targetAgentId = plugin.resolved.agentCard.name;
        const minimalSource: MinimalSourceTaskContext = {
            tenantId,
            agentId: targetAgentId,
            task: { id: sessionId, input: { __conversationSession: true } },
        };
        const targetSpecificOverrides = {
            tenantId,
            agentId: targetAgentId,
            task: {
                id: sessionId,
                input: { __conversationSession: true },
            },
            reply: this.createTargetReply(plugin, undefined),
            progress: this.createTargetProgress(plugin),
            complete: this.createTargetComplete(plugin),
            fail: this.createTargetFail(plugin),
            logger: this.createTargetLogger(plugin),
            throw: this.createTargetThrow(plugin),
            recordUsage: this.createTargetRecordUsage(plugin),
            __activeLoopInbox: undefined,
            __activeLoopEnv: undefined,
            __env: undefined,
            currentTurnNodeId: undefined,
            telemetry: { nodeId: undefined },
        };
        const mergedContext = { ...minimalSource, ...targetSpecificOverrides } as unknown as FullTaskContext;

        const targetCtx = (await extendContextWithMemory(
            mergedContext,
            tenantId,
            targetAgentId,
            plugin.resolved.runtimeManifest,
            undefined,
            await (await import('@a2arium/callagent-memory-engine')).getMemoryPrismaClient()
        )) as unknown as FullTaskContext;

        if (!(targetCtx as Record<string, unknown>).__mental && !(targetCtx as Record<string, unknown>).M) {
            const { initialM } = await import('../loop/init.js');
            (targetCtx as Record<string, unknown>).__mental = initialM(targetCtx);
        }

        if (plugin.resolved.runtimeManifest.config) {
            if (!targetCtx.config || typeof targetCtx.config !== 'object') {
                (targetCtx as Record<string, unknown>).config = {};
            }
            (targetCtx.config as Record<string, unknown>).runtimeManifestConfig = plugin.resolved.runtimeManifest.config;
            (targetCtx as Record<string, unknown>).__runtimeManifestConfig = plugin.resolved.runtimeManifest.config;
        }

        if (!plugin.llmAdapter && plugin.llmConfig) {
            targetCtx.llm = createLLMForTask(plugin.llmConfig, targetCtx);
        } else if (plugin.llmAdapter) {
            targetCtx.llm = plugin.llmAdapter;
        }

        targetCtx.sendTaskToAgent = (async (
            nestedTargetAgent: string,
            nestedTaskInput: import('../shared/types/index.js').TaskInput,
            nestedOptions?: unknown
        ) => {
            return this.sendTaskToAgent(targetCtx as FullTaskContext, nestedTargetAgent, nestedTaskInput, nestedOptions as A2ACallOptions);
        }) as FullTaskContext['sendTaskToAgent'];

        return targetCtx;
    }

    /**
     * Find local agent by name
     */
    async findLocalAgent(agentName: string): Promise<AgentPlugin | null> {
        try {
            const agent = PluginManager.findAgent(agentName);

            if (agent) {
                a2aLogger.debug('Local agent found', {
                    requestedName: agentName,
                    foundName: agent.resolved.agentCard.name,
                    version: agent.resolved.agentCard.version
                });
            } else {
                a2aLogger.warn('Local agent not found', {
                    requestedName: agentName,
                    availableAgents: PluginManager.listAgents().map(a => a.name)
                });
            }

            return agent;
        } catch (error) {
            a2aLogger.error('Error finding local agent', error, { agentName });
            throw error; // Or return null
        }
    }

    /**
 * Create target context with memory capabilities using inheritance pattern
 */
    private async createTargetContext(
        sourceCtx: MinimalSourceTaskContext,
        targetPlugin: AgentPlugin,
        taskInput: TaskInput,
        serializedContext: SerializedAgentContext,
        options: A2ACallOptions
    ): Promise<FullTaskContext> {
        // Start with the source context as base (inherit everything)
        const baseCtx = { ...sourceCtx };

        // Create target-specific overrides only for what needs to be different
        const sourceTaskId = sourceCtx.task.id;
        const targetAgentId = targetPlugin.resolved.agentCard.name;

        // ✅ FIX: Generate unique child task ID to prevent state pollution across different runs
        // For resume scenarios, callers can provide explicit childTaskId via options.childTaskId
        // Otherwise, generate a unique ID using timestamp + random to ensure each call gets fresh state
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const childTaskId = options.childTaskId || `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${uniqueSuffix}`;

        const targetSpecificOverrides = {
            tenantId: serializedContext.tenantId,
            agentId: targetAgentId,
            task: {
                id: childTaskId,
                input: taskInput,
            },

            // Override I/O methods to add target-agent prefixing and logging
            reply: this.createTargetReply(targetPlugin, (options as any).parentTenantId && (options as any).parentTaskId ? {
                tenantId: (options as any).parentTenantId,
                parentTaskId: (options as any).parentTaskId,
                parentChildToken: (options as any).parentChildToken,
            } : undefined),
            progress: this.createTargetProgress(targetPlugin),
            complete: this.createTargetComplete(targetPlugin),
            fail: this.createTargetFail(targetPlugin),

            // Override logger to add target-agent prefixing
            logger: this.createTargetLogger(targetPlugin),

            // Override throw to handle errors safely
            throw: this.createTargetThrow(targetPlugin),

            // Override recordUsage for target-specific tracking
            recordUsage: this.createTargetRecordUsage(targetPlugin),

            // ✅ FIX: Do not inherit parent loop state or telemetry context
            __activeLoopInbox: undefined,
            __activeLoopEnv: undefined,
            __env: undefined,
            currentTurnNodeId: undefined,
            telemetry: { nodeId: undefined },
        };

        // Merge base context with target-specific overrides
        const mergedContext = { ...baseCtx, ...targetSpecificOverrides };

        // Extract semantic adapter from source context for memory inheritance
        let inheritedSemanticAdapter: any = undefined;
        if (sourceCtx.memory?.semantic) {
            // Try to extract the underlying adapter from the MLO backend
            const semanticRegistry = sourceCtx.memory.semantic as any;
            if (semanticRegistry.backends?.mlo?.underlyingAdapter) {
                inheritedSemanticAdapter = semanticRegistry.backends.mlo.underlyingAdapter;
                a2aLogger.debug('Inherited semantic adapter from parent MLO backend', {
                    targetAgent: targetPlugin.resolved.agentCard.name,
                    hasAdapter: !!inheritedSemanticAdapter
                });
            } else if (semanticRegistry.backends?.sql) {
                inheritedSemanticAdapter = semanticRegistry.backends.sql;
                a2aLogger.debug('Inherited semantic adapter from parent SQL backend', {
                    targetAgent: targetPlugin.resolved.agentCard.name,
                    hasAdapter: !!inheritedSemanticAdapter
                });
            } else {
                a2aLogger.debug('No suitable semantic adapter found in parent context', {
                    targetAgent: targetPlugin.resolved.agentCard.name,
                    availableBackends: Object.keys(semanticRegistry.backends || {})
                });
            }
        }

        // Extend with memory capabilities using inherited adapter
        const targetCtx = await extendContextWithMemory(
            mergedContext,
            serializedContext.tenantId,
            targetPlugin.resolved.agentCard.name,
            targetPlugin.resolved.runtimeManifest,
            inheritedSemanticAdapter,
            await (await import('@a2arium/callagent-memory-engine')).getMemoryPrismaClient()
        ) as unknown as FullTaskContext;

        // Initialize MentalState if not present (required for goals/thoughts APIs)
        // This ensures child agents have a valid MentalState even when using the fast path (direct handleTask)
        if (!(targetCtx as any).__mental && !(targetCtx as any).M) {
            const { initialM } = await import('../loop/init.js');
            (targetCtx as any).__mental = initialM(targetCtx);
        }

        // Record manifest config on child context for propagation
        if (targetPlugin.resolved.runtimeManifest.config) {
            if (!targetCtx.config || typeof targetCtx.config !== 'object') {
                (targetCtx as any).config = {};
            }
            (targetCtx.config as any).runtimeManifestConfig = targetPlugin.resolved.runtimeManifest.config;
            (targetCtx as any).__runtimeManifestConfig = targetPlugin.resolved.runtimeManifest.config;
        }

        // Set up LLM configuration for the target agent (similar to runner logic)
        if (!targetPlugin.llmAdapter && targetPlugin.llmConfig) {
            a2aLogger.debug('Creating LLM for target agent', {
                targetAgent: targetPlugin.resolved.agentCard.name,
                provider: targetPlugin.llmConfig.provider,
                model: targetPlugin.llmConfig.modelAliasOrName
            });
            targetCtx.llm = createLLMForTask(targetPlugin.llmConfig, targetCtx);
        } else if (!targetPlugin.llmAdapter && !targetPlugin.llmConfig) {
            a2aLogger.debug('Target agent has no LLM configuration, using stub', {
                targetAgent: targetPlugin.resolved.agentCard.name
            });
            // Keep the inherited LLM (which might be a stub)
        } else if (targetPlugin.llmAdapter) {
            a2aLogger.debug('Target agent has pre-configured LLM adapter', {
                targetAgent: targetPlugin.resolved.agentCard.name
            });
            targetCtx.llm = targetPlugin.llmAdapter;
        }

        // Add A2A capability to target context for nested agent calls
        // Cast to 'any' to bypass overload inference - the implementation handles both cases
        targetCtx.sendTaskToAgent = (async (nestedTargetAgent: string, nestedTaskInput: import('../shared/types/index.js').TaskInput, nestedOptions?: any) => {
            return this.sendTaskToAgent(targetCtx as any, nestedTargetAgent, nestedTaskInput, nestedOptions);
        }) as any;

        // Override requestInput to notify parent (if correlation provided)
        const parentTenantId = (options as any).parentTenantId as string | undefined;
        const parentTaskId = (options as any).parentTaskId as string | undefined;
        const parentChildToken = (options as any).parentChildToken as string | undefined;
        // Override requestInput to only notify parent and avoid mutating parent's WM via inherited method
        // Mark this context so the engine preserves this override
        (targetCtx as any).__preserveRequestInput = true;
        (targetCtx as any).__a2aParent = { parentTenantId, parentTaskId, parentChildToken };
        (targetCtx as any).requestInput = async (promptOrParts: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[], riOpts?: { schema?: unknown; ttlMs?: number; onProvided?: string; onExpired?: string }) => {
            // Normalize parts like ctx.reply
            const normalizeParts = (p: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[]): import('../shared/types/index.js').MessagePart[] => {
                if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' } as any];
                if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' } as any));
                if (Array.isArray(p)) return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                const one = p as any;
                return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
            };
            const parts = normalizeParts(promptOrParts);
            const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;
            try { log.debug('Child requestInput called', { prompt, onProvided: riOpts?.onProvided, parentTenantId, parentTaskId, parentChildToken }); } catch { }
            if (parentTenantId && parentTaskId && parentChildToken) {
                try {
                    const eng = getRequiredEngine();
                    // Persist child's current WM + LLM state BEFORE writing pending input
                    try { await (eng as any).flushContextSnapshot?.(targetCtx.tenantId, targetCtx.task.id, targetPlugin.resolved.agentCard.name, targetCtx as any); } catch { }

                    // Create a real pending input entry in the child's session so resumeInput can work
                    const childToken = uuidv7();
                    const snap = await (eng as any).sessionManager?.load(targetCtx.tenantId, targetCtx.task.id);
                    const base = (snap?.snapshot as Record<string, unknown>) || {};
                    const inputs = getPendingInputs(base);
                    const expiresAt = riOpts?.ttlMs ? new Date(Date.now() + riOpts.ttlMs).toISOString() : undefined;
                    inputs[childToken] = { schema: riOpts?.schema, expiresAt } as any;
                    const next = setPendingInputs(base, inputs);
                    const expected = snap?.wmVersion ?? BigInt(0);
                    await (eng as any).sessionManager?.saveSnapshot({ tenantId: targetCtx.tenantId, sessionId: targetCtx.task.id, agentId: targetPlugin.resolved.agentCard.name, expectedWmVersion: expected, snapshot: next });
                    await (eng as any).sessionManager?.appendEvent(targetCtx.tenantId, targetCtx.task.id, 'task.input_required', { token: childToken, prompt, parts, schema: riOpts?.schema, expiresAt });
                    await (eng as any).sessionManager?.enqueueOutbox(targetCtx.tenantId, 'task.input_required', targetCtx.task.id, { taskId: targetCtx.task.id, prompt, parts, token: childToken, schema: riOpts?.schema, expiresAt });

                    // Now notify parent about input_required
                    const childOnProvided = riOpts?.onProvided;
                    try { log.debug('Child requestInput routed to parent', { childAgent: targetPlugin.resolved.agentCard.name, childOnProvided, prompt }); } catch { }
                    await eng.handleChildInputRequired({
                        tenantId: parentTenantId,
                        parentTaskId,
                        childToken: parentChildToken,
                        childTaskId: targetCtx.task.id,
                        childInputToken: childToken,
                        prompt: prompt ?? '',
                        schema: riOpts?.schema,
                        childOnProvided
                    });
                    (targetCtx as any).__inputRequired = { prompt, schema: riOpts?.schema, childOnProvided, childTaskId: targetCtx.task.id, childInputToken: childToken };
                } catch (err) {
                    a2aLogger.error('Failed to notify parent on child input_required', err as any, { parentTaskId });
                }
            }
            // Return a minimal InputHandle-like object for chaining (include child input token)
            return {
                async onProvided() { return this; },
                async onExpired() { return this; }
                , token: undefined
            } as any;
        };

        a2aLogger.debug('Target context created with inheritance', {
            targetAgent: targetPlugin.resolved.agentCard.name,
            taskId: targetCtx.task.id,
            tenantId: targetCtx.tenantId,
            inheritedMethods: Object.keys(baseCtx).length,
            overriddenMethods: Object.keys(targetSpecificOverrides).length,
            hasLLMConfig: !!targetPlugin.llmConfig,
            hasLLMAdapter: !!targetPlugin.llmAdapter
        });

        return targetCtx;
    }

    /**
     * Create target-specific reply function
     */
    private createTargetReply(targetPlugin: AgentPlugin, parent?: { tenantId: string; parentTaskId: string; parentChildToken?: string }) {
        return async (parts: any) => {
            const prefix = `[${targetPlugin.resolved.agentCard.name}]`;

            if (typeof parts === 'string') {
                console.log(`${prefix} ${parts}`);
            } else if (Array.isArray(parts)) {
                parts.forEach(part => {
                    if (typeof part === 'string') {
                        console.log(`${prefix} ${part}`);
                    } else if (part?.type === 'text') {
                        console.log(`${prefix} ${part.text}`);
                    }
                });
            } else if (parts?.type === 'text') {
                console.log(`${prefix} ${parts.text}`);
            }

            a2aLogger.debug('Target agent reply', {
                targetAgent: targetPlugin.resolved.agentCard.name,
                parts: typeof parts === 'string' ? parts.substring(0, 100) : 'complex'
            });

            // Mirror child replies to parent task stream if correlated
            if (parent?.parentTaskId) {
                try {
                    const text = typeof parts === 'string'
                        ? `${prefix} ${parts}`
                        : Array.isArray(parts)
                            ? parts.map(p => (typeof p === 'string' ? `${prefix} ${p}` : p?.text ? `${prefix} ${p.text}` : '')).filter(Boolean).join('\n')
                            : parts?.text ? `${prefix} ${parts.text}` : '';
                    if (text) {
                        const engine = getRequiredEngine();
                        const now = new Date().toISOString();
                        const debugParts: RuntimeStreamMessagePart[] = [{ type: 'text', text }];
                        const childMessage = RuntimeStreamEventSchema.parse({
                            version: RUNTIME_STREAM_EVENT_VERSION,
                            id: uuidv7(),
                            seq: Date.now(),
                            taskId: parent.parentTaskId,
                            tenantId: parent.tenantId,
                            ts: now,
                            type: 'child.message',
                            visibility: 'debug',
                            channel: 'debug',
                            data: {
                                ...(parent.parentChildToken ? { token: parent.parentChildToken } : {}),
                                agentId: targetPlugin.resolved.agentCard.name,
                                parts: debugParts,
                            },
                        });
                        void engine.eventBus.publish(
                            createBusEvent({
                                channel: taskChannel(parent.parentTaskId),
                                partitionKey: parent.parentTaskId,
                                cloud: {
                                    id: childMessage.id,
                                    type: childMessage.type,
                                    source: `/tasks/${parent.parentTaskId}`,
                                    time: childMessage.ts,
                                    datacontenttype: 'application/json',
                                    data: childMessage,
                                },
                            })
                        );
                        void engine.eventBus.publish(
                            createBusEvent({
                                channel: taskChannel(parent.parentTaskId),
                                partitionKey: parent.parentTaskId,
                                cloud: {
                                    id: uuidv7(),
                                    type: 'task.a2a',
                                    source: `/tasks/${parent.parentTaskId}`,
                                    time: new Date().toISOString(),
                                    datacontenttype: 'application/json',
                                    data: {
                                        artifact: {
                                            name: 'response',
                                            index: 0,
                                            append: false,
                                            lastChunk: false,
                                            parts: [{ type: 'text', text }],
                                        },
                                    },
                                },
                            })
                        );
                    }
                } catch { /* noop */ }
            }
        };
    }

    /**
     * Create target-specific progress function
     */
    private createTargetProgress(targetPlugin: AgentPlugin) {
        return (pct: any, msg?: string) => {
            const prefix = `[${targetPlugin.resolved.agentCard.name}]`;
            if (typeof pct === 'number') {
                console.log(`${prefix} Progress: ${pct}%${msg ? `: ${msg}` : ''}`);
            } else {
                console.log(`${prefix} Status: ${pct?.state || pct}`);
            }

            a2aLogger.debug('Target agent progress', {
                targetAgent: targetPlugin.resolved.agentCard.name,
                progress: pct,
                message: msg
            });
        };
    }

    /**
     * Create target-specific complete function
     */
    private createTargetComplete(targetPlugin: AgentPlugin) {
        return (pct?: number, status?: string) => {
            a2aLogger.debug('Target agent task marked complete', {
                targetAgent: targetPlugin.resolved.agentCard.name,
                status
            });
        };
    }

    /**
     * Create target-specific fail function
     */
    private createTargetFail(targetPlugin: AgentPlugin) {
        return async (error: unknown) => {
            a2aLogger.error('Target agent task failed', error, {
                targetAgent: targetPlugin.resolved.agentCard.name
            });
            throw error; // Re-throw to be caught by executeTargetAgent
        };
    }

    /**
     * Create target-specific logger
     */
    private createTargetLogger(targetPlugin: AgentPlugin) {
        return {
            debug: (msg: string, data?: Record<string, unknown>) => {
                a2aLogger.debug(`[${targetPlugin.resolved.agentCard.name}] ${msg}`, data);
            },
            info: (msg: string, data?: Record<string, unknown>) => {
                a2aLogger.debug(`[${targetPlugin.resolved.agentCard.name}] ${msg}`, data);
            },
            warn: (msg: string, data?: Record<string, unknown>) => {
                a2aLogger.warn(`[${targetPlugin.resolved.agentCard.name}] ${msg}`, data);
            },
            error: (msg: string, error?: unknown, context?: Record<string, unknown>) => {
                a2aLogger.error(`[${targetPlugin.resolved.agentCard.name}] ${msg}`, error, {
                    targetAgent: targetPlugin.resolved.agentCard.name,
                    ...context
                });
            }
        };
    }

    /**
     * Create target-specific throw function
     */
    private createTargetThrow(targetPlugin: AgentPlugin) {
        return (code: string, message: string, details?: unknown): never => {
            let errorToThrow: Error;
            if (details instanceof Error) {
                errorToThrow = details;
                (errorToThrow as any).code = code;
                (errorToThrow as any).details = details;
            } else {
                errorToThrow = new Error(message);
                (errorToThrow as any).code = code;
                (errorToThrow as any).details = details;
            }

            // Safely log the error without circular references
            const safeDetails = details instanceof Error
                ? { message: details.message, name: details.name, stack: details.stack }
                : details;

            a2aLogger.error(`Target agent threw structured error: [${code}] ${message}`, null, {
                targetAgent: targetPlugin.resolved.agentCard.name,
                errorMessage: errorToThrow.message,
                errorName: errorToThrow.name,
                details: safeDetails
            });
            throw errorToThrow;
        };
    }

    /**
     * Create target-specific recordUsage function
     */
    private createTargetRecordUsage(targetPlugin: AgentPlugin) {
        return (usage: any) => {
            a2aLogger.debug('Target agent usage', {
                targetAgent: targetPlugin.resolved.agentCard.name,
                usage
            });
            // TODO: Future - aggregate usage back to source
        };
    }

    /**
     * Execute target agent with error handling and caching
     */
    private async executeTargetAgent(
        targetPlugin: AgentPlugin,
        targetCtx: FullTaskContext,
        operationId: string,
        options: A2ACallOptions
    ): Promise<unknown> {
        return withLoggingContext(
            {
                agentId: targetPlugin.resolved.agentCard.name,
                taskId: targetCtx.task.id,
                tenantId: targetCtx.tenantId,
                parentTaskId: (options as any).parentTaskId,
                correlationId: operationId,
                // ✅ FIX: Prevent parent turn from bleeding into child logs (Blink Effect)
                // LoopRunner will set the correct turn once the loop starts.
                turn: undefined
            },
            async () => {
                let agentNode: AgentNode | undefined;
                let hasLoopModules = false;
                try {
                    const effectiveCache = this.resolveEffectiveCacheConfig(targetPlugin, options);

                    // Telemetry: Create an AgentNode upfront so both cache hits and cache misses produce a stable span
                    try {
                        const parentNodeId = (options as { parentTelemetryNodeId?: string }).parentTelemetryNodeId;
                        const parentNode = parentNodeId ? telemetry.getNode(parentNodeId) : undefined;
                        const traceId = parentNode?.traceId || targetCtx.telemetry?.traceId || uuidv7();
                        const nodeId = uuidv7();
                        agentNode = new AgentNode(targetPlugin.resolved.agentCard.name, nodeId, parentNodeId, traceId);
                        
                        agentNode.start({
                            ...targetCtx.task.input,
                            _cached: effectiveCache.enabled ? 'pending' : 'disabled'
                        });
                        telemetry.registerNode(agentNode);

                        Object.assign(agentNode.providerData, {
                            sessionId: targetCtx.task.id,
                            tenantId: targetCtx.tenantId,
                            parentSessionId: (options as { parentTaskId?: string }).parentTaskId,
                            threadId: traceId,
                        });
                        
                        // Inject telemetry node into targetCtx so TaskEngine avoids recreating it IF it runs
                        if (!targetCtx.telemetry) targetCtx.telemetry = {};
                        targetCtx.telemetry.nodeId = agentNode.id;
                        targetCtx.telemetry.traceId = agentNode.traceId;
                    } catch (tErr) {
                        a2aLogger.warn('A2AService failed to start agent telemetry node', { error: tErr });
                    }

                    // Check cache if enabled (manifest or override)
                    if (this.agentResultCache && effectiveCache.enabled) {
                        const cachedResult = await this.agentResultCache.getCachedResult(
                            targetPlugin.resolved.agentCard.name,
                            targetCtx.task.input,
                            effectiveCache.excludePaths,
                            targetCtx.tenantId
                        );

                        if (cachedResult) {
                            a2aLogger.debug('A2A cache hit', {
                                operationId,
                                targetAgent: targetPlugin.resolved.agentCard.name,
                                taskId: targetCtx.task.id
                            });
                            console.log(`⚡ ${targetPlugin.resolved.agentCard.name} (cached result)\n`);


                            // Hydrate artifacts in cached result before returning
                            try {
                                ArtifactHydrationService.attachHydratedArtifactHandles(
                                    cachedResult,
                                    this.agentResultCache,
                                    targetCtx.tenantId
                                );
                            } catch (hydrationError) {
                                a2aLogger.error('Failed to hydrate artifacts in cached result', hydrationError, {
                                    operationId,
                                    targetAgent: targetPlugin.resolved.agentCard.name
                                });
                                // Continue even if hydration fails, returning the raw result
                            }

                            if (agentNode) {
                                agentNode.end({
                                    status: 'completed',
                                    _origin: 'cache',
                                    result: cachedResult
                                });
                                telemetry.endNode(agentNode);
                            }

                            attachA2aResultTelemetry(cachedResult, {
                                childTraceId: targetCtx.telemetry?.traceId,
                                childAgentNodeId: agentNode?.id,
                            });
                            return cachedResult;
                        }
                    }


                    a2aLogger.info(`\n🔗 Starting ${targetPlugin.resolved.agentCard.name}...`);

                    a2aLogger.debug('Executing target agent', {
                        operationId,
                        targetAgent: targetPlugin.resolved.agentCard.name,
                        taskId: targetCtx.task.id
                    });

                    hasLoopModules = !!(targetPlugin as any)?.loop?.modules && Object.keys((targetPlugin as any).loop.modules || {}).length > 0;
                    const result = hasLoopModules
                        ? await (async () => {
                            // Always route loop-first agents through the engine so A2A overrides are respected
                            const eng = getRequiredEngine();
                            try { await (eng as any).attachWorkingMemory?.(targetCtx as any, targetCtx.tenantId, targetCtx.task.id, targetPlugin.resolved.agentCard.name); } catch { }
                            const entity = { id: targetCtx.task.id, input: targetCtx.task.input };
                            
                            // TaskEngine creates its own trace if parentNodeId is missing. We established one above natively in A2AService, so we pass it.
                            const started = await eng.startTask({ task: entity, isStreaming: false, agentId: targetPlugin.resolved.agentCard.name, tenantId: targetCtx.tenantId, initialContext: targetCtx, parentTelemetryNodeId: agentNode?.id, skipTelemetryNodeCreation: !!agentNode });
                            return started ?? { status: 'started' };
                        })()
                        : (targetPlugin.handleTask
                            ? await targetPlugin.handleTask(targetCtx)
                            : await (async () => {
                                // Fallback: engine path
                                const eng = getRequiredEngine();
                                try { await (eng as any).attachWorkingMemory?.(targetCtx as any, targetCtx.tenantId, targetCtx.task.id, targetPlugin.resolved.agentCard.name); } catch { }
                                const entity = { id: targetCtx.task.id, input: targetCtx.task.input };
                                const started = await eng.startTask({ task: entity, isStreaming: false, agentId: targetPlugin.resolved.agentCard.name, tenantId: targetCtx.tenantId, initialContext: targetCtx, parentTelemetryNodeId: agentNode?.id, skipTelemetryNodeCreation: !!agentNode });
                                return started ?? { status: 'started' };
                            })());

                    // Cache the result if caching is enabled
                    if (this.agentResultCache && effectiveCache.enabled) {
                        try {
                            await this.agentResultCache.setCachedResult(
                                targetPlugin.resolved.agentCard.name,
                                targetCtx.task.input,
                                result,
                                effectiveCache.ttlSeconds,
                                effectiveCache.excludePaths,
                                targetCtx.tenantId
                            );
                        } catch (cacheError) {
                            a2aLogger.error('Failed to cache A2A result', cacheError, {
                                operationId,
                                targetAgent: targetPlugin.resolved.agentCard.name
                            });
                        }
                    }

                    // Hydrate artifacts in the LIVE result before returning
                    // This ensures that if the agent returned markers (from its own memory/cache),
                    // the parent receives functional artifacts.
                    if (this.agentResultCache) {
                        try {
                            ArtifactHydrationService.attachHydratedArtifactHandles(
                                result,
                                this.agentResultCache,
                                targetCtx.tenantId
                            );
                        } catch (hydrationError) {
                            a2aLogger.error('Failed to hydrate artifacts in live result', hydrationError, {
                                operationId,
                                targetAgent: targetPlugin.resolved.agentCard.name
                            });
                        }
                    }

                    console.log(`✅ ${targetPlugin.resolved.agentCard.name} completed\n`);

                    a2aLogger.debug('Target agent execution completed', {
                        operationId,
                        targetAgent: targetPlugin.resolved.agentCard.name,
                        hasResult: !!result
                    });

                    // We already hooked TaskEngine to end the node if it was a startTask invocation. 
                    // However, for pure fallback JS handleTask plugins, we might need to close it here.
                    if (agentNode && !hasLoopModules && targetPlugin.handleTask) {
                         agentNode.end({ status: 'completed', result });
                         telemetry.endNode(agentNode);
                    }

                    attachA2aResultTelemetry(result, {
                        childTraceId: targetCtx.telemetry?.traceId,
                        childAgentNodeId: agentNode?.id,
                    });
                    return result;
                } catch (error) {
                    a2aLogger.error('Target agent execution failed', error, {
                        operationId,
                        targetAgent: targetPlugin.resolved.agentCard.name
                    });
                    if (agentNode && agentNode.endTime == null) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        agentNode.fail(err);
                        telemetry.failNode(agentNode, err);
                        telemetry.endNode(agentNode);
                    }
                    throw error;
                }
            }
        );
    }

    private resolveEffectiveCacheConfig(targetPlugin: AgentPlugin, options: A2ACallOptions) {
        const manifestCache = targetPlugin.resolved.runtimeManifest.cache ?? {};
        const overrideCache = options.cache;
        return {
            enabled: overrideCache?.enabled ?? manifestCache.enabled ?? false,
            ttlSeconds: overrideCache?.ttlSeconds ?? manifestCache.ttlSeconds ?? 300,
            excludePaths: overrideCache?.excludePaths ?? manifestCache.excludePaths ?? []
        };
    }
}

// Export singleton instance
export const globalA2AService = new A2AService(); 
