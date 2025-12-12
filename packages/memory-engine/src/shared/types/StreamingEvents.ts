// src/shared/types/StreamingEvents.ts
// A2A Protocol streaming event types (SSE)
import type { Message, MessagePart } from './index.js';

// Define minimal types we need for A2A compatibility
export type TaskStatus = {
    state: TaskState;
    message?: Message;
    timestamp?: string; // ISO 8601 timestamp
    metadata?: Record<string, unknown>; // Add optional metadata field
};

export type TaskState =
    | 'submitted'
    | 'working'
    | 'input-required'
    | 'completed'
    | 'canceled'
    | 'failed'
    | 'unknown';

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
    id: string; // Task ID
    status: TaskStatus;
    final: boolean; // true if this is the terminal update for the task
    metadata?: Record<string, unknown>;
};

/**
 * Event sent when a new or updated artifact is available
 */
export type TaskArtifactUpdateEvent = {
    id: string; // Task ID
    artifact: Artifact;
    final?: boolean; // rarely true for artifacts 
    metadata?: Record<string, unknown>;
};

/**
 * Union type for all A2A stream events
 */
export type A2AEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent; 