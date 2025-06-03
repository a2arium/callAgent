import type { MinimalSourceTaskContext, RecalledMemoryItem } from '../../shared/types/A2ATypes.js';
import type {
    A2ACallOptions,
    SerializedAgentContext,
    SerializedWorkingMemory,
    SerializedMemoryContext
} from '../../shared/types/A2ATypes.js';
import type { DecisionEntry } from '../../shared/types/workingMemory.js';
import type { TaskContext } from '../../shared/types/index.js';
import { logger } from '@callagent/utils';

const serializerLogger = logger.createLogger({ prefix: 'ContextSerializer' });

/**
 * Service for serializing and deserializing agent context
 * Integrates with MLO pipeline and existing memory operations
 */
export class ContextSerializer {
    /**
     * Serialize agent context for transfer to another agent
     */
    static async serializeContext(
        sourceCtx: MinimalSourceTaskContext,
        options: A2ACallOptions
    ): Promise<SerializedAgentContext> {
        const startTime = Date.now();

        serializerLogger.debug('Starting context serialization', {
            sourceTaskId: sourceCtx.task.id,
            tenantId: sourceCtx.tenantId,
            sourceAgentId: sourceCtx.agentId,
            options
        });

        const serialized: SerializedAgentContext = {
            tenantId: options.tenantId || sourceCtx.tenantId,
            sourceTaskId: sourceCtx.task.id,
            sourceAgentId: sourceCtx.agentId,
            timestamp: new Date().toISOString()
        };

        try {
            // Serialize working memory if requested
            if (options.inheritWorkingMemory) {
                serialized.workingMemory = await this.serializeWorkingMemory(sourceCtx);
            }

            // Serialize long-term memory if requested  
            if (options.inheritMemory) {
                serialized.memoryContext = await this.serializeMemoryContext(sourceCtx);
            }

            const duration = Date.now() - startTime;
            serializerLogger.info('Context serialization completed', {
                sourceTaskId: sourceCtx.task.id,
                sourceAgentId: sourceCtx.agentId,
                duration,
                hasWorkingMemory: !!serialized.workingMemory,
                hasMemoryContext: !!serialized.memoryContext
            });

            return serialized;
        } catch (error) {
            serializerLogger.error('Context serialization failed', error, {
                sourceTaskId: sourceCtx.task.id,
                sourceAgentId: sourceCtx.agentId
            });
            throw error;
        }
    }

    /**
     * Deserialize context into target agent
     */
    static async deserializeContext(
        targetCtx: TaskContext,
        serializedContext: SerializedAgentContext
    ): Promise<void> {
        const startTime = Date.now();

        serializerLogger.debug('Starting context deserialization', {
            targetTaskId: targetCtx.task.id,
            sourceTaskId: serializedContext.sourceTaskId,
            tenantId: serializedContext.tenantId
        });

        try {
            // Restore working memory
            if (serializedContext.workingMemory) {
                await this.deserializeWorkingMemory(targetCtx, serializedContext.workingMemory);
            }

            // Restore long-term memory
            if (serializedContext.memoryContext) {
                await this.deserializeMemoryContext(targetCtx, serializedContext.memoryContext);
            }

            const duration = Date.now() - startTime;
            serializerLogger.info('Context deserialization completed', {
                targetTaskId: targetCtx.task.id,
                duration
            });
        } catch (error) {
            serializerLogger.error('Context deserialization failed', error, {
                targetTaskId: targetCtx.task.id,
                sourceTaskId: serializedContext.sourceTaskId
            });
            throw error;
        }
    }

    /**
     * Serialize working memory using existing MLO operations
     */
    private static async serializeWorkingMemory(
        ctx: MinimalSourceTaskContext
    ): Promise<SerializedWorkingMemory> {
        const workingMemory: SerializedWorkingMemory = {
            thoughts: [],
            decisions: {},
            variables: {}
        };

        try {
            // Use existing TaskContext APIs
            if (ctx.getGoal) {
                const goal = await ctx.getGoal() || undefined;
                workingMemory.goal = goal;

                serializerLogger.debug('Serializing goal', {
                    goalType: typeof goal,
                    goalValue: goal ? String(goal).substring(0, 100) : 'null',
                    goalLength: goal ? String(goal).length : 0
                });
            }

            if (ctx.getThoughts) {
                workingMemory.thoughts = await ctx.getThoughts();
            }

            // Extract decisions - use MLO method if available
            if (ctx.memory?.mlo?.getAllDecisions) {
                workingMemory.decisions = await ctx.memory.mlo.getAllDecisions(ctx.agentId);
            } else {
                serializerLogger.warn('getAllDecisions method not found on MLO for working memory serialization');
            }

            // Extract variables
            if (ctx.vars) {
                // Convert proxy to plain object if necessary
                workingMemory.variables = { ...ctx.vars };
            }

            serializerLogger.debug('Working memory serialized', {
                hasGoal: !!workingMemory.goal,
                thoughtCount: workingMemory.thoughts.length,
                decisionCount: Object.keys(workingMemory.decisions).length,
                variableCount: Object.keys(workingMemory.variables).length
            });

            return workingMemory;
        } catch (error) {
            serializerLogger.error('Working memory serialization failed', error);
            throw error;
        }
    }

    /**
     * Serialize memory context using MLO recall operations
     */
    private static async serializeMemoryContext(
        ctx: MinimalSourceTaskContext
    ): Promise<SerializedMemoryContext> {
        try {
            // Use MLO recall to get relevant context
            const recalledItems: RecalledMemoryItem[] = [];
            if (ctx.recall) {
                const rawRecalledItems = await ctx.recall('context transfer', {
                    limit: 10,
                    sources: ['semantic', 'episodic']
                }) || [];

                // Transform raw recalled items into RecalledMemoryItem structure
                for (const item of rawRecalledItems) {
                    if (item && typeof item.id === 'string' && typeof item.type === 'string' && item.data) {
                        recalledItems.push({
                            id: item.id,
                            type: item.type, // Type is already 'semantic' | 'episodic' | string from RecalledMemoryItem
                            data: item.data,
                            metadata: item.metadata
                        });
                    } else {
                        serializerLogger.warn('Skipping malformed recalled item during serialization', { item });
                    }
                }
            }

            const memoryContext: SerializedMemoryContext = {
                episodicEventCount: recalledItems.filter(item => item.type === 'episodic').length,
                memorySnapshot: recalledItems
            };

            serializerLogger.debug('Memory context serialized', {
                snapshotItemCount: memoryContext.memorySnapshot.length,
                episodicEventCount: memoryContext.episodicEventCount
            });

            return memoryContext;
        } catch (error) {
            serializerLogger.error('Memory context serialization failed', error);
            throw error;
        }
    }

    /**
     * Deserialize working memory into target context
     */
    private static async deserializeWorkingMemory(
        ctx: TaskContext,
        workingMemory: SerializedWorkingMemory
    ): Promise<void> {
        try {
            // Restore goal
            if (workingMemory.goal && ctx.setGoal) {
                // Ensure goal is a string - handle complex objects from MLO processing
                let goalString: string;
                if (typeof workingMemory.goal === 'string') {
                    goalString = workingMemory.goal;
                } else if (workingMemory.goal && typeof workingMemory.goal === 'object') {
                    // Handle MLO-processed goal objects dynamically
                    goalString = this.extractContentFromModalityFusion(workingMemory.goal as any);
                } else {
                    goalString = String(workingMemory.goal);
                }

                serializerLogger.debug('Deserializing goal', {
                    originalType: typeof workingMemory.goal,
                    goalString: goalString.substring(0, 100),
                    goalLength: goalString.length
                });

                // For A2A context transfer, bypass MLO processing and set goal directly in adapter
                // This avoids the MLO pipeline size limits and complex object transformations
                const unifiedMemory = (ctx.memory as any)?.unified;
                if (unifiedMemory?.workingMemoryAdapter?.setGoal) {
                    try {
                        await unifiedMemory.workingMemoryAdapter.setGoal(goalString, ctx.agentId, ctx.tenantId);
                        serializerLogger.debug('Goal set directly in adapter for A2A transfer', {
                            agentId: ctx.agentId,
                            goalLength: goalString.length
                        });
                    } catch (error) {
                        serializerLogger.warn('Failed to set goal directly in adapter, falling back to MLO', error);
                        await ctx.setGoal(goalString);
                    }
                } else {
                    await ctx.setGoal(goalString);
                }
            }

            // Restore thoughts
            if (ctx.addThought && workingMemory.thoughts) {
                for (const thought of workingMemory.thoughts) {
                    await ctx.addThought(thought.content);
                }
            }

            // Restore decisions
            if (ctx.makeDecision && workingMemory.decisions) {
                for (const [key, decision] of Object.entries(workingMemory.decisions)) {
                    await ctx.makeDecision(key, decision.decision, decision.reasoning);
                }
            }

            // Restore variables
            if (ctx.vars && workingMemory.variables) {
                Object.assign(ctx.vars, workingMemory.variables);
            }

            serializerLogger.debug('Working memory deserialized successfully');
        } catch (error) {
            serializerLogger.error('Working memory deserialization failed', error);
            throw error;
        }
    }

    /**
     * Deserialize memory context into target
     */
    private static async deserializeMemoryContext(
        ctx: TaskContext,
        memoryContext: SerializedMemoryContext
    ): Promise<void> {
        try {
            // Restore memories from the snapshot
            if (ctx.remember && memoryContext.memorySnapshot) {
                for (const item of memoryContext.memorySnapshot) {
                    // Use the preserved type and id/key from RecalledMemoryItem
                    // Only pass semantic/episodic types, filter out other types
                    const memoryType = item.type === 'semantic' || item.type === 'episodic' ? item.type : undefined;
                    await ctx.remember(item.id, item.data, {
                        type: memoryType,
                        persist: true
                    });
                }
            }

            serializerLogger.debug('Memory context deserialized successfully', {
                snapshotItemCount: memoryContext.memorySnapshot?.length || 0
            });
        } catch (error) {
            serializerLogger.error('Memory context deserialization failed', error);
            throw error;
        }
    }

    /**
     * Create a snapshot of memory data for transfer
     */
    private static createMemorySnapshot(memories: unknown[]): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};

        memories.forEach((memory, index) => {
            snapshot[`transferred_memory_${index}`] = memory;
        });

        return snapshot;
    }

    /**
     * Dynamically extract content from ModalityFusion output
     * Supports any modality type (text, audio, image, video, sensor, etc.)
     */
    private static extractContentFromModalityFusion(obj: any): string {
        // First, try to find any modality with .content property
        for (const [key, value] of Object.entries(obj)) {
            if (value && typeof value === 'object' && (value as any).content) {
                const content = (value as any).content;
                if (typeof content === 'string') {
                    return content;
                } else if (content && typeof content === 'object') {
                    // Handle nested structures
                    return JSON.stringify(content);
                }
            }
        }

        // Fallback: try direct properties
        if (obj.text) return typeof obj.text === 'string' ? obj.text : JSON.stringify(obj.text);
        if (obj.content) return typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);

        // Final fallback: stringify the whole object
        return JSON.stringify(obj);
    }
} 