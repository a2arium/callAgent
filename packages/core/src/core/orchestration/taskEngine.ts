import type { TaskContext, TaskInput } from '../../shared/types/index.js';
import type { TaskStatus, Artifact } from '../../shared/types/StreamingEvents.js';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../context/StreamingContext.js';

/**
 * Task entity with the necessary properties for the task engine
 */
export type TaskEntity = {
    id: string;
    input: unknown;
    status?: TaskStatus;
    artifacts?: Artifact[];
};

/**
 * Parameters for starting a task
 */
export type StartTaskParams = {
    task: TaskEntity;
    isStreaming: boolean;
};

/**
 * A minimal task engine that handles task execution
 * This is a simplified implementation that would use XState in a full framework
 */
export class TaskEngine {
    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    async startTask(params: StartTaskParams): Promise<TaskEntity | void> {
        const { task, isStreaming } = params;

        // Create a basic context for the task
        const ctx = this.createContext(task);

        // Extend the context with streaming capabilities
        extendContextWithStreaming(ctx, isStreaming);

        try {
            // Set initial status
            const initialStatus: TaskStatus = {
                state: 'submitted',
                timestamp: new Date().toISOString()
            };

            // Update status to 'working'
            ctx.progress({
                state: 'working',
                timestamp: new Date().toISOString()
            });

            // For streaming mode, there's no return value - events are sent via EventBus
            if (isStreaming) {
                // Start the task handler process in the background without awaiting it
                // When the task handler completes/fails, it will emit final events
                this.executeTaskHandler(ctx).catch(error => {
                    console.error('Task handler error:', error);

                    // Send failure event
                    ctx.fail({
                        state: 'failed',
                        message: {
                            role: 'agent',
                            parts: [
                                { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
                            ]
                        },
                        timestamp: new Date().toISOString()
                    });
                });

                // Return undefined for streaming mode (client doesn't await completion)
                return;
            }

            // For buffered mode, await the task handler completion
            await this.executeTaskHandler(ctx);

            // Get the buffered results from the context
            const results = (ctx as any).getBufferedResults();

            // Update the task entity with the results
            task.status = results.status || {
                state: 'completed',
                timestamp: new Date().toISOString()
            };
            task.artifacts = results.artifacts;

            // Return the updated task
            return task;
        } catch (error) {
            console.error('Task engine error:', error);

            // Set failure status for non-streaming mode
            if (!isStreaming) {
                task.status = {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                };
                return task;
            }

            // For streaming, emit a failure event directly
            eventBus.publish(taskChannel(task.id), {
                id: task.id,
                status: {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                },
                final: true
            });
        }
    }

    /**
     * Execute the task handler
     * In a real implementation, this would find and call the correct agent plugin
     */
    private async executeTaskHandler(ctx: TaskContext): Promise<void> {
        // This is a placeholder for a real implementation that would
        // find the appropriate agent plugin and call its handleTask method
        console.log('Executing task handler (placeholder):', ctx.task.id);
        // This would be replaced with:
        // const plugin = pluginRegistry.getAgentForTask(ctx.task.id);
        // await plugin.handleTask(ctx);
    }

    /**
     * Create a basic task context
     */
    private createContext(task: TaskEntity): TaskContext {
        // This is a simplified version - a real implementation would
        // inject all required dependencies like LLM, tools, etc.
        return {
            tenantId: 'default', // TODO: Get from agent/task context
            task: {
                id: task.id,
                input: task.input as TaskInput
            },
            // These will be replaced by the streaming context
            reply: async () => { },
            progress: () => { },
            complete: () => { },
            fail: async () => { },
            // Add stub for recordUsage
            recordUsage: () => { console.warn('recordUsage called on base context'); },
            // Stub implementations for other required properties
            llm: {} as any,
            tools: { invoke: async <T>() => ({} as unknown as T) },
            memory: {
                semantic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    get: async () => null,
                    set: async () => { },
                    getMany: async () => [],
                    delete: async () => { },
                },
                episodic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    append: async () => { },
                    getEvents: async () => [],
                    deleteEvent: async () => { },
                },
                embed: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    upsert: async () => { },
                    queryByVector: async () => [],
                    delete: async () => { },
                }
            },
            cognitive: {
                loadWorkingMemory: () => { },
                plan: async () => ({}),
                record: () => { },
                flush: async () => { }
            },
            logger: {
                debug: () => { },
                info: () => { },
                warn: () => { },
                error: () => { }
            },
            config: {},
            validate: () => { },
            retry: async (fn) => fn(),
            cache: {
                get: async () => null,
                set: async () => { },
                delete: async () => { }
            },
            emitEvent: async () => { },
            updateStatus: () => { },
            services: { get: () => undefined },
            getEnv: () => undefined,
            throw: (code, message) => { throw new Error(`${code}: ${message}`); }
        };
    }
}

// Export a singleton instance
export const taskEngine = new TaskEngine(); 