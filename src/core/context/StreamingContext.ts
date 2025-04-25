import type { TaskContext, Message, MessagePart } from '../../shared/types/index.js';
import type {
    TaskStatus,
    TaskState,
    Artifact
} from '../../shared/types/StreamingEvents.js';
import type { Usage } from '../../shared/types/LLMTypes.js';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';

/**
 * Options for the reply method
 */
export type ReplyOpts = {
    artifactName?: string;
    index?: number;
    append?: boolean;
    lastChunk?: boolean;
};

/**
 * Internal engine event types
 */
export type InternalEngineEvent =
    | { kind: 'REPLY'; taskId: string; parts: MessagePart[]; opts: ReplyOpts }
    | { kind: 'STATUS'; taskId: string; status: TaskStatus }
    | { kind: 'FINAL'; taskId: string; status: TaskStatus; artifacts?: Artifact[] };

/**
 * Extend the context with streaming capabilities
 * @param ctx - The task context to extend
 * @param isStreaming - Whether to stream events (true) or buffer until completion (false)
 */
export function extendContextWithStreaming(
    ctx: TaskContext,
    isStreaming: boolean
): void {
    // Store buffered responses if not streaming
    const buffer = {
        artifacts: [] as Artifact[],
        latestStatus: null as TaskStatus | null
    };
    // Add state to hold accumulated cost
    let accumulatedCost: number = 0;

    // Get logger if available or use console as fallback
    const logger = ctx.logger || console;

    // Helper to emit or buffer events
    const emitEvent = (event: InternalEngineEvent): void => {
        // Log the event
        logger.debug('A2A event emitted', {
            taskId: event.taskId,
            streaming: isStreaming,
            eventKind: event.kind
        });

        // Process based on the event kind
        switch (event.kind) {
            case 'REPLY':
                // Create a new artifact from the reply parts
                const artifact: Artifact = {
                    name: event.opts.artifactName || 'response',
                    parts: event.parts,
                    index: event.opts.index || 0,
                    append: event.opts.append,
                    lastChunk: event.opts.lastChunk
                };

                if (isStreaming) {
                    // Emit directly to the event bus for streaming
                    eventBus.publish(taskChannel(event.taskId), {
                        id: event.taskId,
                        artifact,
                        final: event.opts.lastChunk
                    });
                    logger.debug('Streaming artifact', {
                        taskId: event.taskId,
                        artifactName: artifact.name,
                        partCount: artifact.parts.length,
                        isLast: event.opts.lastChunk
                    });
                } else {
                    // Add to buffer for later return
                    buffer.artifacts.push(artifact);
                    logger.debug('Buffering artifact for later return', {
                        taskId: event.taskId,
                        bufferedCount: buffer.artifacts.length
                    });
                }
                break;

            case 'STATUS':
                // Store the latest status
                buffer.latestStatus = event.status;
                logger.debug('Task status update', {
                    taskId: event.taskId,
                    state: event.status.state,
                    streaming: isStreaming
                });

                if (isStreaming) {
                    // Emit directly to the event bus for streaming
                    const isFinal = event.status.state === 'completed' ||
                        event.status.state === 'failed' ||
                        event.status.state === 'canceled';

                    eventBus.publish(taskChannel(event.taskId), {
                        id: event.taskId,
                        status: event.status,
                        final: isFinal
                    });

                    if (isFinal) {
                        logger.info('Task completed in streaming mode', {
                            taskId: event.taskId,
                            state: event.status.state
                        });
                    }
                }
                break;

            case 'FINAL':
                // For both streaming and buffered mode, this is the final event
                const isFinal = true;

                logger.info('Task final state reached', {
                    taskId: event.taskId,
                    state: event.status.state,
                    streaming: isStreaming
                });

                // Emit the final status
                if (isStreaming) {
                    // Status event with final flag
                    eventBus.publish(taskChannel(event.taskId), {
                        id: event.taskId,
                        status: event.status,
                        final: isFinal
                    });

                    // If there are final artifacts, emit them too
                    if (event.artifacts && event.artifacts.length > 0) {
                        for (const artifact of event.artifacts) {
                            eventBus.publish(taskChannel(event.taskId), {
                                id: event.taskId,
                                artifact,
                                final: false // Only the status is truly final
                            });
                        }
                        logger.debug('Emitted final artifacts in streaming mode', {
                            taskId: event.taskId,
                            artifactCount: event.artifacts.length
                        });
                    }
                } else {
                    // For buffered mode, store the final status
                    buffer.latestStatus = event.status;

                    // Add any final artifacts to the buffer
                    if (event.artifacts && event.artifacts.length > 0) {
                        buffer.artifacts.push(...event.artifacts);
                        logger.debug('Added final artifacts to buffer', {
                            taskId: event.taskId,
                            totalBufferedArtifacts: buffer.artifacts.length
                        });
                    }
                }
                break;
        }
    };

    // Add streaming extensions to the context
    Object.assign(ctx, {
        // Send a reply with artifact options
        reply: async (
            parts: string | string[] | MessagePart | MessagePart[],
            opts: ReplyOpts = {}
        ): Promise<void> => {
            let arrayParts: MessagePart[];
            if (typeof parts === 'string') {
                arrayParts = [{ type: 'text', text: parts }];
            } else if (Array.isArray(parts) && typeof parts[0] === 'string') {
                arrayParts = (parts as string[]).map(text => ({ type: 'text', text }));
            } else if (Array.isArray(parts)) {
                arrayParts = parts as MessagePart[];
            } else {
                arrayParts = [parts as MessagePart];
            }
            emitEvent({
                kind: 'REPLY',
                taskId: ctx.task.id,
                parts: arrayParts,
                opts
            });
        },

        // Update task progress with a status
        progress: function (statusOrPct: TaskStatus | number, msg?: string): void {
            // If it's a number, it's the original percentage-based progress
            if (typeof statusOrPct === 'number') {
                // Call the original implementation if needed
                logger.debug('Progress update (percentage)', {
                    taskId: ctx.task.id,
                    percentage: statusOrPct,
                    message: msg
                });
                return;
            }

            // Otherwise it's a TaskStatus object for streaming
            emitEvent({
                kind: 'STATUS',
                taskId: ctx.task.id,
                status: statusOrPct
            });
        },

        // Simplified implementation for recordUsage that accepts cost directly
        recordUsage: (cost: number | { cost: number } | Usage): void => {
            // Handle different input formats
            let costValue: number;

            if (typeof cost === 'number') {
                // Direct cost number
                costValue = cost;
            } else if ('cost' in cost) {
                // { cost: number } format
                costValue = cost.cost;
            } else {
                // Legacy Usage object format - extract costs.total
                costValue = cost.costs?.total || 0;
            }

            // Simply add the cost value to the accumulated cost
            accumulatedCost += costValue;

            logger.debug('Usage recorded', {
                taskId: ctx.task.id,
                cost: costValue,
                totalAccumulatedCost: accumulatedCost
            });
        },

        // Modify complete to include usage metadata
        complete: (pctOrStatus?: number, statusStr?: string): void => {
            const finalStatus: TaskStatus = {
                state: (statusStr || 'completed') as TaskState,
                timestamp: new Date().toISOString(),
                metadata: accumulatedCost > 0 ? { usage: { cost: accumulatedCost } } : undefined
            };
            if (typeof pctOrStatus === 'number') {
                (finalStatus as any).progress = pctOrStatus;
            }
            emitEvent({
                kind: 'FINAL',
                taskId: ctx.task.id,
                status: finalStatus
            });
            accumulatedCost = 0; // Reset after sending
        },

        // Modify fail to handle unknown error type and include usage metadata
        fail: async (error: unknown): Promise<void> => {
            let errorMessage = 'Task failed';
            if (error instanceof Error) {
                errorMessage = error.message;
            }

            // Create a base TaskStatus for failure
            const finalStatus: TaskStatus = {
                state: 'failed',
                timestamp: new Date().toISOString(),
                message: {
                    role: 'agent',
                    parts: [{ type: 'text', text: errorMessage }]
                },
                metadata: accumulatedCost > 0 ? { usage: { cost: accumulatedCost } } : {}
            };

            // Note: The original implementation expected a TaskStatus. 
            // If specific error details from an incoming TaskStatus were needed, 
            // we'd need type checking here.

            emitEvent({
                kind: 'FINAL',
                taskId: ctx.task.id,
                status: finalStatus
            });
            accumulatedCost = 0; // Reset after sending
        },

        // Signal that the task requires more input
        requireInput: (inputStatus: TaskStatus): void => {
            // Ensure the status is marked as input-required
            const status: TaskStatus = {
                ...inputStatus,
                state: 'input-required' as TaskState
            };

            emitEvent({
                kind: 'FINAL',
                taskId: ctx.task.id,
                status
            });
        },

        // Get the buffered results (for buffered mode)
        getBufferedResults: (): { status: TaskStatus | null; artifacts: Artifact[] } => {
            return {
                status: buffer.latestStatus,
                artifacts: buffer.artifacts
            };
        },

        // Structured error throw
        throw: (code: string, message: string, details?: unknown): never => {
            let errorToThrow: Error;
            if (details instanceof Error) {
                errorToThrow = details;
                // Optionally, attach code/message if not present
                (errorToThrow as any).code = code;
                (errorToThrow as any).details = details;
            } else {
                errorToThrow = new Error(message);
                (errorToThrow as any).code = code;
                (errorToThrow as any).details = details;
            }
            logger.error(`Agent threw structured error: [${code}] ${message}`, errorToThrow, { details });
            throw errorToThrow;
        },
    });
} 