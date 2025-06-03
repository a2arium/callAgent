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
     * Create target context with memory capabilities
     */
    private async createTargetContext(
        sourceCtx: MinimalSourceTaskContext, // Source context for reference (e.g., LLM, tools, config)
        targetPlugin: AgentPlugin,
        taskInput: TaskInput,
        serializedContext: SerializedAgentContext, // Use the fully serialized context
        options: A2ACallOptions
    ): Promise<FullTaskContext> { // Returns FullTaskContext
        // Create base context for target agent
        const baseTargetContextPartial = {
            tenantId: serializedContext.tenantId, // Use tenantId from serialized context
            agentId: targetPlugin.manifest.name, // Target agent's ID
            task: {
                id: `a2a_task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                input: taskInput,
                // Potentially link to source task:
                // parentTaskId: serializedContext.sourceTaskId 
            },
            reply: async (parts: any) => {
                // Forward to console with agent prefix for demo visibility
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
                // TODO: Future - consider mechanism to forward reply to source agent if interactive
            },
            progress: (pct: any, msg?: string) => {
                // Forward to console with agent prefix for demo visibility
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
                // TODO: Future - consider mechanism to forward progress to source agent if interactive
            },
            complete: (pct?: number, status?: string) => { // pct is usually 100 here
                a2aLogger.info('Target agent task marked complete', {
                    targetAgent: targetPlugin.manifest.name,
                    status
                });
            },
            fail: async (error: unknown) => {
                a2aLogger.error('Target agent task failed', error, {
                    targetAgent: targetPlugin.manifest.name
                });
                // This fail is for the *target agent's task*. The A2AService will handle its own error propagation.
                throw error; // Re-throw to be caught by executeTargetAgent
            },
            recordUsage: (usage: any) => {
                a2aLogger.debug('Target agent usage', {
                    targetAgent: targetPlugin.manifest.name,
                    usage
                });
                // TODO: Future - aggregate usage back to source
            },
            llm: sourceCtx.llm, // Share LLM instance from source (if appropriate & stateless)
            tools: sourceCtx.tools, // Share tools from source (if appropriate & stateless)
            // Memory will be populated by extendContextWithMemory.
            // Avoid passing sourceCtx.memory directly. Configuration should drive new instance creation.
        };

        // Extend with memory capabilities using existing infrastructure.
        // Crucially, this should create *new* memory service instances for the targetCtx,
        // configured based on targetPlugin.manifest and tenantId, not reuse sourceCtx.memory instances.
        const targetCtx = await extendContextWithMemory(
            baseTargetContextPartial, // Pass the partial context
            baseTargetContextPartial.tenantId,
            targetPlugin.manifest.name, // agentId for the target
            targetPlugin.manifest, // agent config for memory profile (from target's manifest)
            // Do NOT pass sourceCtx.memory?.semantic or other adapters directly.
            // extendContextWithMemory should initialize new adapters for the target.
            // If config is needed from source, pass specific config values, not service instances.
            undefined // Or pass configuration options if extendContextWithMemory supports it
        ) as FullTaskContext; // Cast to full TaskContext

        // Add A2A capability to target context for nested agent calls
        targetCtx.sendTaskToAgent = async (nestedTargetAgent, nestedTaskInput, nestedOptions) => {
            return this.sendTaskToAgent(targetCtx as any, nestedTargetAgent, nestedTaskInput, nestedOptions);
        };

        a2aLogger.debug('Target context created', {
            targetAgent: targetPlugin.manifest.name,
            taskId: targetCtx.task.id,
            tenantId: targetCtx.tenantId
        });

        return targetCtx;
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