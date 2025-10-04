import type { Message, MessagePart } from './index.js';
export type TaskStatus = {
    state: TaskState;
    message?: Message;
    timestamp?: string;
    metadata?: Record<string, unknown>;
};
export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'unknown';
export type Artifact = {
    name?: string;
    description?: string;
    parts: MessagePart[];
    index?: number;
    append?: boolean;
    lastChunk?: boolean;
    metadata?: Record<string, unknown>;
};
/**
 * Event sent when a task's status changes
 */
export type TaskStatusUpdateEvent = {
    id: string;
    status: TaskStatus;
    final: boolean;
    metadata?: Record<string, unknown>;
};
/**
 * Event sent when a new or updated artifact is available
 */
export type TaskArtifactUpdateEvent = {
    id: string;
    artifact: Artifact;
    final?: boolean;
    metadata?: Record<string, unknown>;
};
/**
 * Union type for all A2A stream events
 */
export type A2AEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
