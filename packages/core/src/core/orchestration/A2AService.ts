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
import { logger } from '@callagent/utils';
import { createLLMForTask } from '../llm/LLMFactory.js';

const a2aLogger = logger.createLogger({ prefix: 'A2AService' });

/**
 * Service for agent-to-agent communication
 * Handles local agent discovery, context transfer, and task execution
 */
export class A2AService implements IA2AService {
    constructor(
        private eventBus?: any // Future: for interactive communication
    ) { }

    /**
     * Send task to another agent with context inheritance
     */
    async sendTaskToAgent(
        sourceCtx: MinimalSourceTaskContext, // Use MinimalSourceTaskContext
        targetAgent: string,
        taskInput: TaskInput,
        options: A2ACallOptions = {}
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
                throw new Error(`Agent '${targetAgent}' not found`);
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

            // 5. Check if streaming/interactive mode is requested
            if (options.streaming) {
                // Return InteractiveTaskHandler for future streaming support
                const interactiveHandler = new InteractiveTaskHandler(targetCtx.task.id, targetAgent);

                // Execute target agent asynchronously and mark completion
                this.executeTargetAgent(targetPlugin, targetCtx, operationId)
                    .then(result => {
                        interactiveHandler.markCompleted(result);
                        const duration = Date.now() - startTime;
                        a2aLogger.info('A2A interactive task completed', {
                            operationId,
                            duration,
                            success: true
                        });
                    })
                    .catch(error => {
                        interactiveHandler.markCompleted(error);
                        const duration = Date.now() - startTime;
                        a2aLogger.error('A2A interactive task failed', error, {
                            operationId,
                            duration,
                            targetAgent
                        });
                    });

                return interactiveHandler;
            } else {
                // 5. Execute target agent synchronously
                const result = await this.executeTargetAgent(targetPlugin, targetCtx, operationId);

                const duration = Date.now() - startTime;
                a2aLogger.info('A2A task completed', {
                    operationId,
                    duration,
                    success: true // Consider deriving success from result or targetCtx state
                });

                return result;
            }

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
            reply: this.createTargetReply(targetPlugin),
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
    private createTargetReply(targetPlugin: AgentPlugin) {
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
            debug: (msg: string, ...args: unknown[]) => {
                a2aLogger.debug(`[${targetPlugin.manifest.name}] ${msg}`, ...args);
            },
            info: (msg: string, ...args: unknown[]) => {
                a2aLogger.info(`[${targetPlugin.manifest.name}] ${msg}`, ...args);
            },
            warn: (msg: string, ...args: unknown[]) => {
                a2aLogger.warn(`[${targetPlugin.manifest.name}] ${msg}`, ...args);
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
     * Execute target agent with error handling
     */
    private async executeTargetAgent(
        targetPlugin: AgentPlugin,
        targetCtx: FullTaskContext,
        operationId: string
    ): Promise<unknown> {
        try {
            console.log(`\n🔗 Starting ${targetPlugin.manifest.name}...`);

            a2aLogger.debug('Executing target agent', {
                operationId,
                targetAgent: targetPlugin.manifest.name,
                taskId: targetCtx.task.id
            });

            const result = await targetPlugin.handleTask(targetCtx);

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