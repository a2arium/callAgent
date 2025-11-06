import type { TaskInput, TaskContext as FullTaskContext } from '../../shared/types/index.js'; // Full TaskContext for target
import type {
    MinimalSourceTaskContext, // Use for sourceCtx type
    A2ACallOptions,
    InteractiveTaskResult,
    IA2AService,
    SerializedAgentContext // Added import
} from '../../shared/types/A2ATypes.js';
import type { AgentPlugin } from '../plugin/types.js';
import { ContextSerializer } from './ContextSerializer.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { extendContextWithMemory } from '../memory/types/working/context/workingMemoryContext.js';
import { InteractiveTaskHandler } from './InteractiveTaskResult.js';
import { logger } from '@a2arium/callagent-utils';
import { createLLMForTask } from '../llm/LLMFactory.js';
import { AgentResultCache } from '../cache/index.js';
import { taskEngine } from './taskEngine.js';
import { EngineLocator } from './EngineLocator.js';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { getPendingInputs, setPendingInputs } from './DurableHandlerRegistry.js';
import { v4 as uuidv4 } from 'uuid';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';

const a2aLogger = logger.createLogger({ prefix: 'A2AService' });

/**
 * Service for agent-to-agent communication
 * Handles local agent discovery, context transfer, and task execution
 */
export class A2AService implements IA2AService {
    private agentResultCache: AgentResultCache | null = null;

    constructor(
        private eventBus?: any // Future: for interactive communication
    ) {
        // Initialize cache service
        this.initializeCacheService().catch(error => {
            a2aLogger.error('Failed to initialize A2A cache service', error);
        });
    }

    /**
     * Initialize cache service for A2A operations
     */
    private async initializeCacheService(): Promise<void> {
        try {
            const { PrismaClient } = await import('@prisma/client');
            const prisma = new PrismaClient();
            this.agentResultCache = new AgentResultCache(prisma);
            a2aLogger.debug('A2A cache service initialized successfully');
        } catch (error) {
            a2aLogger.error('A2A cache service initialization failed, continuing without caching', error);
        }
    }

    /**
     * Send task to another agent with context inheritance
     */
    async sendTaskToAgent(
        sourceCtx: MinimalSourceTaskContext, // Use MinimalSourceTaskContext
        targetAgent: string,
        taskInput: TaskInput,
        options: A2ACallOptions & { parentTenantId?: string; parentTaskId?: string; parentChildToken?: string } = {}
    ): Promise<InteractiveTaskResult | unknown> {
        const startTime = Date.now();
        const operationId = `a2a_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        a2aLogger.info('A2A task initiated', {
            operationId,
            sourceTaskId: sourceCtx.task.id,
            sourceAgentId: sourceCtx.agentId,
            targetAgent,
            tenantId: options.tenantId || sourceCtx.tenantId,
            options
        });

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

            // 3. Create target context
            const targetCtx = await this.createTargetContext(
                sourceCtx, // Pass MinimalSourceTaskContext
                targetPlugin,
                taskInput,
                serializedContext, // Pass serialized context for inspection if needed
                options
            );

            // 4. Deserialize context into target
            await ContextSerializer.deserializeContext(targetCtx, serializedContext);

            // 5. Execute target agent via TaskEngine for WM/LLM persistence
            const eng = EngineLocator.getEngine() || taskEngine;
            // Attach WM proxy so child ctx.vars writes persist
            try { (eng as any).attachWorkingMemory?.(targetCtx as any, targetCtx.tenantId, targetCtx.task.id, targetPlugin.manifest.name); } catch { }

            const result = await this.executeTargetAgent(targetPlugin, targetCtx, operationId);

            // If child signaled input_required via targetCtx flag, route to parent and do not treat as completed
            if ((targetCtx as any).__inputRequired && options.parentTenantId && options.parentTaskId && options.parentChildToken) {
                // Guard: blocking await with non-terminal (input_required) is unsupported
                if ((options as any)?.awaitCompletion === true) {
                    const childName = targetPlugin.manifest.name;
                    throw new Error(
                        `Child agent '${childName}' requested await_input while parent awaited completion. ` +
                        `This is not supported for awaitCompletion=true. Fix by either: ` +
                        `make the child complete in one turn for this path, or call with awaitCompletion=false and propagate await_child from the parent.`
                    );
                }
                const eng = EngineLocator.getEngine() || taskEngine;
                const { prompt, schema, childOnProvided, childTaskId } = (targetCtx as any).__inputRequired as { prompt: string; schema?: unknown; childOnProvided?: string; childTaskId?: string };
                try { console.log(`[A2AService] Post-turn child input_required routing -> parent (childOnProvided='${childOnProvided}', childTaskId='${childTaskId}') prompt='${prompt}'`); } catch { }
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
                    `Child agent '${targetPlugin.manifest.name}' returned await_input while parent awaited completion.`,
                    `This is not supported for awaitCompletion=true.`,
                    `Fix by either:`,
                    `- Making the child return 'complete' in one turn for this path (blocking).`,
                    `- Or call with awaitCompletion=false and propagate await_child from the parent.`,
                ].join(' ');
                throw new Error(msg);
            }

            const duration = Date.now() - startTime;
            a2aLogger.info('A2A task completed', {
                operationId,
                duration,
                success: true
            });

            // Notify parent engine on completion when correlation is provided
            if (options.parentTenantId && options.parentTaskId && options.parentChildToken) {
                const deliverCompletion = async () => {
                    await eng.handleChildCompleted({
                        tenantId: options.parentTenantId!,
                        parentTaskId: options.parentTaskId!,
                        childToken: options.parentChildToken!,
                        result,
                        childAgentId: targetPlugin.manifest.name
                    });
                };

                if (options.awaitCompletion === false) {
                    queueMicrotask(() => {
                        deliverCompletion().catch(notifyError => {
                            a2aLogger.error('Failed to notify parent on child completion (deferred)', notifyError as any, {
                                parentTaskId: options.parentTaskId
                            });
                        });
                    });
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
                    await (eng as any).flushContextSnapshot?.(targetCtx.tenantId, targetCtx.task.id, targetPlugin.manifest.name, targetCtx as any);
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
     * Find local agent by name
     */
    async findLocalAgent(agentName: string): Promise<AgentPlugin | null> {
        try {
            const agent = PluginManager.findAgent(agentName);

            if (agent) {
                a2aLogger.debug('Local agent found', {
                    requestedName: agentName,
                    foundName: agent.manifest.name,
                    version: agent.manifest.version
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
        const targetSpecificOverrides = {
            tenantId: serializedContext.tenantId,
            agentId: targetPlugin.manifest.name,
            task: {
                id: `a2a_task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                input: taskInput,
            },

            // Override I/O methods to add target-agent prefixing and logging
            reply: this.createTargetReply(targetPlugin, (options as any).parentTenantId && (options as any).parentTaskId ? { tenantId: (options as any).parentTenantId, parentTaskId: (options as any).parentTaskId } : undefined),
            progress: this.createTargetProgress(targetPlugin),
            complete: this.createTargetComplete(targetPlugin),
            fail: this.createTargetFail(targetPlugin),

            // Override logger to add target-agent prefixing
            logger: this.createTargetLogger(targetPlugin),

            // Override throw to handle errors safely
            throw: this.createTargetThrow(targetPlugin),

            // Override recordUsage for target-specific tracking
            recordUsage: this.createTargetRecordUsage(targetPlugin)
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
                    targetAgent: targetPlugin.manifest.name,
                    hasAdapter: !!inheritedSemanticAdapter
                });
            } else if (semanticRegistry.backends?.sql) {
                inheritedSemanticAdapter = semanticRegistry.backends.sql;
                a2aLogger.debug('Inherited semantic adapter from parent SQL backend', {
                    targetAgent: targetPlugin.manifest.name,
                    hasAdapter: !!inheritedSemanticAdapter
                });
            } else {
                a2aLogger.debug('No suitable semantic adapter found in parent context', {
                    targetAgent: targetPlugin.manifest.name,
                    availableBackends: Object.keys(semanticRegistry.backends || {})
                });
            }
        }

        // Extend with memory capabilities using inherited adapter
        const targetCtx = await extendContextWithMemory(
            mergedContext,
            serializedContext.tenantId,
            targetPlugin.manifest.name,
            targetPlugin.manifest,
            inheritedSemanticAdapter
        ) as FullTaskContext;

        // Set up LLM configuration for the target agent (similar to runner logic)
        if (!targetPlugin.llmAdapter && targetPlugin.llmConfig) {
            a2aLogger.debug('Creating LLM for target agent', {
                targetAgent: targetPlugin.manifest.name,
                provider: targetPlugin.llmConfig.provider,
                model: targetPlugin.llmConfig.modelAliasOrName
            });
            targetCtx.llm = createLLMForTask(targetPlugin.llmConfig, targetCtx);
        } else if (!targetPlugin.llmAdapter && !targetPlugin.llmConfig) {
            a2aLogger.debug('Target agent has no LLM configuration, using stub', {
                targetAgent: targetPlugin.manifest.name
            });
            // Keep the inherited LLM (which might be a stub)
        } else if (targetPlugin.llmAdapter) {
            a2aLogger.debug('Target agent has pre-configured LLM adapter', {
                targetAgent: targetPlugin.manifest.name
            });
            targetCtx.llm = targetPlugin.llmAdapter;
        }

        // Add A2A capability to target context for nested agent calls
        targetCtx.sendTaskToAgent = async (nestedTargetAgent, nestedTaskInput, nestedOptions) => {
            return this.sendTaskToAgent(targetCtx as any, nestedTargetAgent, nestedTaskInput, nestedOptions);
        };

        // Override requestInput to notify parent (if correlation provided)
        const parentTenantId = (options as any).parentTenantId as string | undefined;
        const parentTaskId = (options as any).parentTaskId as string | undefined;
        const parentChildToken = (options as any).parentChildToken as string | undefined;
        // Override requestInput to only notify parent and avoid mutating parent's WM via inherited method
        // Mark this context so the engine preserves this override
        (targetCtx as any).__preserveRequestInput = true;
        (targetCtx as any).__a2aParent = { parentTenantId, parentTaskId, parentChildToken };
        (targetCtx as any).requestInput = async (promptOrParts: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[], riOpts?: { schema?: unknown; ttlMs?: number; onProvided?: string; onExpired?: string }) => {
            // Normalize parts like ctx.reply
            const normalizeParts = (p: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[]): import('../../shared/types/index.js').MessagePart[] => {
                if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' } as any];
                if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' } as any));
                if (Array.isArray(p)) return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                const one = p as any;
                return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
            };
            const parts = normalizeParts(promptOrParts);
            const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;
            try { console.log(`[A2AService] Child requestInput called: prompt='${prompt || ''}' onProvided='${riOpts?.onProvided}' parentTenantId=${parentTenantId} parentTaskId=${parentTaskId} parentChildToken=${parentChildToken}`); } catch { }
            if (parentTenantId && parentTaskId && parentChildToken) {
                try {
                    const eng = EngineLocator.getEngine() || taskEngine;
                    // Persist child's current WM + LLM state BEFORE writing pending input
                    try { await (eng as any).flushContextSnapshot?.(targetCtx.tenantId, targetCtx.task.id, targetPlugin.manifest.name, targetCtx as any); } catch { }

                    // Create a real pending input entry in the child's session so resumeInput can work
                    const childToken = uuidv4();
                    const snap = await (eng as any).sessionManager?.load(targetCtx.tenantId, targetCtx.task.id);
                    const base = (snap?.snapshot as Record<string, unknown>) || {};
                    const inputs = getPendingInputs(base);
                    const expiresAt = riOpts?.ttlMs ? new Date(Date.now() + riOpts.ttlMs).toISOString() : undefined;
                    inputs[childToken] = { schema: riOpts?.schema, expiresAt } as any;
                    const next = setPendingInputs(base, inputs);
                    const expected = snap?.wmVersion ?? BigInt(0);
                    await (eng as any).sessionManager?.saveSnapshot({ tenantId: targetCtx.tenantId, sessionId: targetCtx.task.id, agentId: targetPlugin.manifest.name, expectedWmVersion: expected, snapshot: next });
                    await (eng as any).sessionManager?.appendEvent(targetCtx.tenantId, targetCtx.task.id, 'task.input_required', { token: childToken, prompt, parts, schema: riOpts?.schema, expiresAt });
                    await (eng as any).sessionManager?.enqueueOutbox(targetCtx.tenantId, 'task.input_required', targetCtx.task.id, { taskId: targetCtx.task.id, prompt, parts, token: childToken, schema: riOpts?.schema, expiresAt });

                    // Now notify parent about input_required
                    const childOnProvided = riOpts?.onProvided;
                    try { console.log(`[A2AService] Child '${targetPlugin.manifest.name}' requestInput -> parent onInputRequired (childOnProvided='${childOnProvided}') prompt='${prompt || ''}'`); } catch { }
                    await eng.handleChildInputRequired({
                        tenantId: parentTenantId,
                        parentTaskId,
                        childToken: parentChildToken,
                        childTaskId: targetCtx.task.id,
                        childInputToken: childToken,
                        prompt,
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
            targetAgent: targetPlugin.manifest.name,
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
    private createTargetReply(targetPlugin: AgentPlugin, parent?: { tenantId: string; parentTaskId: string }) {
        return async (parts: any) => {
            const prefix = `[${targetPlugin.manifest.name}]`;

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
                targetAgent: targetPlugin.manifest.name,
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
                        eventBus.publish(taskChannel(parent.parentTaskId), {
                            artifact: {
                                name: 'response', index: 0, append: false, lastChunk: false,
                                parts: [{ type: 'text', text }]
                            }
                        } as any);
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
            const prefix = `[${targetPlugin.manifest.name}]`;
            if (typeof pct === 'number') {
                console.log(`${prefix} Progress: ${pct}%${msg ? `: ${msg}` : ''}`);
            } else {
                console.log(`${prefix} Status: ${pct?.state || pct}`);
            }

            a2aLogger.debug('Target agent progress', {
                targetAgent: targetPlugin.manifest.name,
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
            a2aLogger.info('Target agent task marked complete', {
                targetAgent: targetPlugin.manifest.name,
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
                targetAgent: targetPlugin.manifest.name
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
                a2aLogger.debug(`[${targetPlugin.manifest.name}] ${msg}`, data);
            },
            info: (msg: string, data?: Record<string, unknown>) => {
                a2aLogger.info(`[${targetPlugin.manifest.name}] ${msg}`, data);
            },
            warn: (msg: string, data?: Record<string, unknown>) => {
                a2aLogger.warn(`[${targetPlugin.manifest.name}] ${msg}`, data);
            },
            error: (msg: string, error?: unknown, context?: Record<string, unknown>) => {
                a2aLogger.error(`[${targetPlugin.manifest.name}] ${msg}`, error, {
                    targetAgent: targetPlugin.manifest.name,
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
                targetAgent: targetPlugin.manifest.name,
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
                targetAgent: targetPlugin.manifest.name,
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
        operationId: string
    ): Promise<unknown> {
        try {
            // Check cache if enabled for target agent
            if (this.agentResultCache && targetPlugin.manifest.cache?.enabled) {
                const cachedResult = await this.agentResultCache.getCachedResult(
                    targetPlugin.manifest.name,
                    targetCtx.task.input,
                    targetPlugin.manifest.cache.excludePaths || [],
                    targetCtx.tenantId
                );

                if (cachedResult) {
                    a2aLogger.info('A2A cache hit', {
                        operationId,
                        targetAgent: targetPlugin.manifest.name,
                        taskId: targetCtx.task.id
                    });
                    console.log(`⚡ ${targetPlugin.manifest.name} (cached result)\n`);
                    return cachedResult;
                }
            }

            console.log(`\n🔗 Starting ${targetPlugin.manifest.name}...`);

            a2aLogger.debug('Executing target agent', {
                operationId,
                targetAgent: targetPlugin.manifest.name,
                taskId: targetCtx.task.id
            });

            const hasLoopModules = !!(targetPlugin as any)?.loop?.modules && Object.keys((targetPlugin as any).loop.modules || {}).length > 0;
            const result = hasLoopModules
                ? await (async () => {
                    // Always route loop-first agents through the engine so A2A overrides are respected
                    const eng = EngineLocator.getEngine() || taskEngine;
                    try { (eng as any).attachWorkingMemory?.(targetCtx as any, targetCtx.tenantId, targetCtx.task.id, targetPlugin.manifest.name); } catch { }
                    const entity = { id: targetCtx.task.id, input: targetCtx.task.input } as any;
                    const started = await eng.startTask({ task: entity, isStreaming: false, agentId: targetPlugin.manifest.name, tenantId: targetCtx.tenantId, initialContext: targetCtx as any });
                    return started ?? { status: 'started' } as any;
                })()
                : (targetPlugin.handleTask
                    ? await targetPlugin.handleTask(targetCtx)
                    : await (async () => {
                        // Fallback: engine path
                        const eng = EngineLocator.getEngine() || taskEngine;
                        try { (eng as any).attachWorkingMemory?.(targetCtx as any, targetCtx.tenantId, targetCtx.task.id, targetPlugin.manifest.name); } catch { }
                        const entity = { id: targetCtx.task.id, input: targetCtx.task.input } as any;
                        const started = await eng.startTask({ task: entity, isStreaming: false, agentId: targetPlugin.manifest.name, tenantId: targetCtx.tenantId, initialContext: targetCtx as any });
                        return started ?? { status: 'started' } as any;
                    })());

            // Cache the result if caching is enabled
            if (this.agentResultCache && targetPlugin.manifest.cache?.enabled) {
                try {
                    await this.agentResultCache.setCachedResult(
                        targetPlugin.manifest.name,
                        targetCtx.task.input,
                        result,
                        targetPlugin.manifest.cache.ttlSeconds || 300,
                        targetPlugin.manifest.cache.excludePaths || [],
                        targetCtx.tenantId
                    );
                } catch (cacheError) {
                    a2aLogger.error('Failed to cache A2A result', cacheError, {
                        operationId,
                        targetAgent: targetPlugin.manifest.name
                    });
                }
            }

            console.log(`✅ ${targetPlugin.manifest.name} completed\n`);

            a2aLogger.debug('Target agent execution completed', {
                operationId,
                targetAgent: targetPlugin.manifest.name,
                hasResult: !!result
            });

            return result;
        } catch (error) {
            a2aLogger.error('Target agent execution failed', error, {
                operationId,
                targetAgent: targetPlugin.manifest.name
            });
            throw error;
        }
    }
}

// Export singleton instance
export const globalA2AService = new A2AService(); 