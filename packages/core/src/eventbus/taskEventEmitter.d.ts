import { EventEmitter } from 'node:events';
import type { TaskStatus, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Artifact } from '../shared/types/StreamingEvents.js';
export declare const taskChannel: (id: string) => string;
export type TaskEvents = {
    'status': (event: TaskStatusUpdateEvent) => void;
    'artifact': (event: TaskArtifactUpdateEvent) => void;
};
/**
 * Creates a new event emitter for task events
 */
export declare function createTaskEventEmitter(): EventEmitter;
/**
 * Emit a task status update event
 */
export declare function emitTaskStatus(emitter: EventEmitter, event: TaskStatusUpdateEvent): void;
/**
 * Emit a task artifact update event
 */
export declare function emitTaskArtifact(emitter: EventEmitter, event: TaskArtifactUpdateEvent): void;
/**
 * Convert an internal event to a TaskStatusUpdateEvent
 */
export declare function toStatusUpdateEvent(taskId: string, status: TaskStatus, isFinal: boolean): TaskStatusUpdateEvent;
/**
 * Convert an internal event to a TaskArtifactUpdateEvent
 */
export declare function toArtifactUpdateEvent(taskId: string, artifact: Artifact, isFinal?: boolean): TaskArtifactUpdateEvent;
