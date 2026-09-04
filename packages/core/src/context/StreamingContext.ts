import type { TaskContext, Message, MessagePart, UsageRecord } from '../shared/types/index.js';
import type { InvariantErrorCode, InvariantErrorContext, InvariantErrorDetail } from '../types/invariantError.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type {
    TaskStatus,
    TaskState,
    Artifact
} from '../shared/types/StreamingEvents.js';
// no provider-specific Usage type in public API anymore
import { createInMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { logger } from '@a2arium/callagent-utils';
import { v7 as uuidv7 } from 'uuid';
import { currentTaskTurnClaim } from '../runtime/segmentProcessedKeys.js';
import type { InternalTaskContext } from '../loop/internalContext.js';

const TASK_REPLY_CAPABILITY = Symbol('callagent.taskReplyCapability');

type TaskReplyCapabilityMarker = {
    eventBus: IEventBus;
    isStreaming: boolean;
};

type ContextWithTaskReplyCapability = TaskContext & {
    [TASK_REPLY_CAPABILITY]?: TaskReplyCapabilityMarker;
};

export const TASK_REPLY_CAPABILITY_UNAVAILABLE = 'TASK_REPLY_CAPABILITY_UNAVAILABLE';

export class TaskReplyCapabilityUnavailableError extends Error {
    readonly code = TASK_REPLY_CAPABILITY_UNAVAILABLE;

    constructor(taskId?: string) {
        super(
            `${TASK_REPLY_CAPABILITY_UNAVAILABLE}: reply/progress capability was not ` +
            `finalized${taskId ? ` for task ${taskId}` : ''}.`
        );
        this.name = 'TaskReplyCapabilityUnavailableError';
        Object.setPrototypeOf(this, TaskReplyCapabilityUnavailableError.prototype);
    }
}

export function hasTaskReplyCapability(
    ctx: TaskContext,
    expected?: { eventBus?: IEventBus; isStreaming?: boolean }
): boolean {
    const marker = (ctx as ContextWithTaskReplyCapability)[TASK_REPLY_CAPABILITY];
    if (marker === undefined) return false;
    if (expected?.eventBus !== undefined && marker.eventBus !== expected.eventBus) return false;
    if (expected?.isStreaming !== undefined && marker.isStreaming !== expected.isStreaming) return false;
    return true;
}

export function assertTaskReplyCapability(
    ctx: TaskContext,
    expected?: { eventBus?: IEventBus; isStreaming?: boolean }
): void {
    if (!hasTaskReplyCapability(ctx, expected)) {
        throw new TaskReplyCapabilityUnavailableError(ctx.task?.id);
    }
}

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
 * @param eventBusParam - Task engine bus; when omitted, a new in-memory bus is used (standalone runners only).
 */
export function extendContextWithStreaming(
    ctx: TaskContext,
    isStreaming: boolean,
    eventBusParam?: IEventBus
): void {
    // Runtime adapters and older custom contexts may omit the optional progress
    // facade entirely. The streaming layer installs the canonical callable
    // facade below, preserving durable reporting only when it already exists.
    const durableProgressReport = ctx.progress?.report;
    const capabilityContext = ctx as ContextWithTaskReplyCapability;
    const existingCapability = capabilityContext[TASK_REPLY_CAPABILITY];
    const eventBus = eventBusParam ?? existingCapability?.eventBus ?? createInMemoryEventBus();
    if (
        existingCapability?.eventBus === eventBus &&
        existingCapability.isStreaming === isStreaming
    ) {
        return;
    }

    const publishA2aPayload = (taskId: string, data: Record<string, unknown>): void => {
        void eventBus.publish(
            createBusEvent({
                channel: taskChannel(taskId),
                partitionKey: taskId,
                cloud: {
                    id: uuidv7(),
                    type: 'task.a2a',
                    source: `/tasks/${taskId}`,
                    time: new Date().toISOString(),
                    datacontenttype: 'application/json',
                    data,
                },
            })
        );
    };

    // Store buffered responses if not streaming
    const buffer = {
        artifacts: [] as Artifact[],
        latestStatus: null as TaskStatus | null
    };
    // Add state to hold accumulated usage
    let totalCost: number = 0;
    const byKind: Record<string, number> = {};
    const internalCtx = ctx as InternalTaskContext;
    const resetUsage = (): void => {
        totalCost = 0;
        for (const k of Object.keys(byKind)) delete byKind[k];
    };
    const bufferTerminalIntent = (intent: InternalTaskContext['__pendingTerminalIntent']): void => {
        internalCtx.__pendingTerminalIntent = intent;
    };
    internalCtx.__clearTerminalIntent = (): void => {
        internalCtx.__pendingTerminalIntent = undefined;
        resetUsage();
    };

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
                    try {
                        logger.debug('Streaming artifact publish', { channel: taskChannel(event.taskId) });
                    } catch {
                        /* noop */
                    }
                    publishA2aPayload(event.taskId, {
                        id: event.taskId,
                        artifact,
                        final: false,
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
                if (!['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'].includes(event.status.state)) {
                    throw new Error(`INVALID_TASK_STATE: ${String(event.status.state)}`);
                }
                // Store the latest status
                buffer.latestStatus = event.status;
                logger.debug('Task status update', {
                    taskId: event.taskId,
                    state: event.status.state,
                    streaming: isStreaming
                });

                // Emit in non-streaming for working and input-required so CLI can show prompts
                const shouldEmitStatusEvent = isStreaming || event.status.state === 'working' || (event.status.state as any) === 'input-required';

                if (shouldEmitStatusEvent) {
                    // Emit directly to the event bus for streaming or progress events
                    const isFinal = event.status.state === 'completed' ||
                        event.status.state === 'failed' ||
                        event.status.state === 'canceled';

                    try {
                        logger.debug('Streaming status publish', {
                            channel: taskChannel(event.taskId),
                            state: event.status.state,
                        });
                    } catch {
                        /* noop */
                    }
                    publishA2aPayload(event.taskId, {
                        id: event.taskId,
                        status: event.status,
                        final: isFinal,
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
                if (!['input-required', 'completed', 'failed', 'canceled'].includes(event.status.state)) {
                    throw new Error(`INVALID_TASK_FINAL_STATE: ${String(event.status.state)}`);
                }
                // Input-required pauses an interactive task; it is not terminal.
                const isFinal = event.status.state === 'completed' ||
                    event.status.state === 'failed' || event.status.state === 'canceled';

                logger.info('Task final state reached', {
                    taskId: event.taskId,
                    state: event.status.state,
                    streaming: isStreaming
                });

                // Emit the final status
                if (isStreaming) {
                    publishA2aPayload(event.taskId, {
                        id: event.taskId,
                        status: event.status,
                        final: isFinal,
                    });

                    if (event.artifacts && event.artifacts.length > 0) {
                        for (const artifact of event.artifacts) {
                            publishA2aPayload(event.taskId, {
                                id: event.taskId,
                                artifact,
                                final: false,
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
                arrayParts = [{ type: 'text', text: parts, format: 'markdown' } as MessagePart];
            } else if (Array.isArray(parts) && typeof parts[0] === 'string') {
                arrayParts = (parts as string[]).map(text => ({ type: 'text', text, format: 'markdown' } as MessagePart));
            } else if (Array.isArray(parts)) {
                arrayParts = (parts as MessagePart[]).map(p => (p.type === 'text' && !p.format ? { ...p, format: 'markdown' as const } : p));
            } else {
                const p = parts as MessagePart;
                arrayParts = [p.type === 'text' && !p.format ? { ...p, format: 'markdown' as const } : p];
            }
            emitEvent({
                kind: 'REPLY',
                taskId: ctx.task.id,
                parts: arrayParts,
                opts
            });
        },

        // Update task progress with a status or percentage
        progress: function (statusOrPct: TaskStatus | number, msg?: string): void {
            // If it's a number, convert it to a TaskStatus and emit it
            if (typeof statusOrPct === 'number') {
                const progressStatus: TaskStatus = {
                    state: 'working',
                    timestamp: new Date().toISOString(),
                    metadata: { progress: statusOrPct },
                    message: msg ? {
                        role: 'agent',
                        parts: [{ type: 'text', text: msg }]
                    } : undefined
                };

                emitEvent({
                    kind: 'STATUS',
                    taskId: ctx.task.id,
                    status: progressStatus
                });
                return;
            }

            const state = (statusOrPct as { state?: unknown }).state;
            const knownStates = new Set([
                'submitted', 'working', 'input-required', 'completed', 'failed', 'canceled',
            ]);
            if (typeof state !== 'string' || !knownStates.has(state)) {
                throw new Error(`INVALID_TASK_STATE: ${String(state)}`);
            }
            if (
                currentTaskTurnClaim() !== undefined &&
                (state === 'completed' || state === 'failed' || state === 'canceled')
            ) {
                const message = statusOrPct.message?.parts
                    ?.filter((part) => part.type === 'text')
                    .map((part) => (part as { text?: string }).text)
                    .filter((text): text is string => typeof text === 'string')
                    .join(' ');
                bufferTerminalIntent({
                    state,
                    ...(message ? { message } : {}),
                    ...(totalCost > 0 ? { usage: { totalCost, byKind: { ...byKind } } } : {}),
                });
                return;
            }

            // Otherwise it's a TaskStatus object for streaming/legacy mode.
            emitEvent({
                kind: 'STATUS',
                taskId: ctx.task.id,
                status: statusOrPct
            });
        },

        // Usage recording: number shortcut or detailed record
        recordUsage: (usage: number | UsageRecord): void => {
            let record: UsageRecord;
            if (typeof usage === 'number') {
                record = { cost: usage, kind: 'other' };
            } else {
                record = { ...usage };
            }
            const inc = Number(record.cost) || 0;
            totalCost += inc;
            const k = record.kind || 'other';
            byKind[k] = (byKind[k] || 0) + inc;
            try {
                logger.debug('Usage recorded', { taskId: ctx.task.id, record, totalCost, byKind });
            } catch { /* noop */ }
        },

        // Read-only accessor for current usage totals (for mid-run observability)
        getUsage: (): { totalCost: number; byKind: Record<string, number> } => ({
            totalCost,
            byKind: { ...byKind }
        }),

        // Modify complete to include usage metadata
        complete: (pctOrStatus?: number, statusStr?: string): void => {
            const finalStatus: TaskStatus = {
                state: 'completed',
                timestamp: new Date().toISOString(),
                ...(statusStr ? {
                    message: { role: 'agent', parts: [{ type: 'text', text: statusStr }] },
                } : {}),
                metadata: totalCost > 0 ? { usage: { totalCost, byKind: { ...byKind } } } : undefined
            };
            if (typeof pctOrStatus === 'number') {
                finalStatus.metadata = { ...finalStatus.metadata, progress: pctOrStatus };
            }
            if (currentTaskTurnClaim() !== undefined) {
                bufferTerminalIntent({
                    state: 'completed',
                    ...(statusStr ? { message: statusStr } : {}),
                    ...(typeof pctOrStatus === 'number' ? { progress: pctOrStatus } : {}),
                    ...(totalCost > 0 ? { usage: { totalCost, byKind: { ...byKind } } } : {}),
                });
                return;
            }
            emitEvent({
                kind: 'FINAL',
                taskId: ctx.task.id,
                status: finalStatus
            });
            resetUsage();
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
                metadata: totalCost > 0 ? { usage: { totalCost, byKind: { ...byKind } } } : {}
            };

            if (currentTaskTurnClaim() !== undefined) {
                bufferTerminalIntent({
                    state: 'failed',
                    message: errorMessage,
                    ...(totalCost > 0 ? { usage: { totalCost, byKind: { ...byKind } } } : {}),
                });
                return;
            }

            // Note: The original implementation expected a TaskStatus. 
            // If specific error details from an incoming TaskStatus were needed, 
            // we'd need type checking here.

            emitEvent({
                kind: 'FINAL',
                taskId: ctx.task.id,
                status: finalStatus
            });
            resetUsage();
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

        // Structured error throw — delegates to throwInvariantError so all runtimes get InvariantError
        throw: (code: InvariantErrorCode, message: string, detail: InvariantErrorDetail, context?: InvariantErrorContext): never => {
            logger.error(`Agent threw structured error: [${code}] ${message}`, { code, message, detailType: detail.type });
            throwInvariantError(code, message, detail, context);
        },
    });
    if (durableProgressReport) ctx.progress.report = durableProgressReport;
    Object.defineProperty(capabilityContext, TASK_REPLY_CAPABILITY, {
        value: { eventBus, isStreaming },
        configurable: true,
        enumerable: false,
        writable: false,
    });
} 
