import { EventEmitter } from 'node:events';
import type {
    TaskStatus,
    TaskStatusUpdateEvent,
    TaskArtifactUpdateEvent,
    Artifact
} from '../shared/types/StreamingEvents.js';

// Create a helper for consistent channel naming
export const taskChannel = (id: string) => `task.${id}.events`;

// Task event types (used for internal subscriptions)
export type TaskEvents = {
    'status': (event: TaskStatusUpdateEvent) => void;
    'artifact': (event: TaskArtifactUpdateEvent) => void;
}

/**
 * Creates a new event emitter for task events
 */
export function createTaskEventEmitter(): EventEmitter {
    return new EventEmitter();
}

/**
 * Emit a task status update event
 */
export function emitTaskStatus(
    emitter: EventEmitter,
    event: TaskStatusUpdateEvent
): void {
    emitter.emit('status', event);
}

/**
 * Emit a task artifact update event
 */
export function emitTaskArtifact(
    emitter: EventEmitter,
    event: TaskArtifactUpdateEvent
): void {
    emitter.emit('artifact', event);
}

/**
 * Convert an internal event to a TaskStatusUpdateEvent
 */
export function toStatusUpdateEvent(
    taskId: string,
    status: TaskStatus,
    isFinal: boolean
): TaskStatusUpdateEvent {
    return {
        id: taskId,
        status,
        final: isFinal
    };
}

/**
 * Convert an internal event to a TaskArtifactUpdateEvent
 */
export function toArtifactUpdateEvent(
    taskId: string,
    artifact: Artifact,
    isFinal?: boolean
): TaskArtifactUpdateEvent {
    return {
        id: taskId,
        artifact,
        final: isFinal
    };
} 