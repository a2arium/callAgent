import type { TaskContext, MessagePart } from '../../shared/types/index.js';
import type { TaskStatus, Artifact } from '../../shared/types/StreamingEvents.js';
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
export type InternalEngineEvent = {
    kind: 'REPLY';
    taskId: string;
    parts: MessagePart[];
    opts: ReplyOpts;
} | {
    kind: 'STATUS';
    taskId: string;
    status: TaskStatus;
} | {
    kind: 'FINAL';
    taskId: string;
    status: TaskStatus;
    artifacts?: Artifact[];
};
/**
 * Extend the context with streaming capabilities
 * @param ctx - The task context to extend
 * @param isStreaming - Whether to stream events (true) or buffer until completion (false)
 */
export declare function extendContextWithStreaming(ctx: TaskContext, isStreaming: boolean): void;
