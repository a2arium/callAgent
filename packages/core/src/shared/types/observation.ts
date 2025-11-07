import type { Observation } from '../../loop/oneTurn.js';
import type { Artifact, TaskStatus } from './StreamingEvents.js';

/**
 * Task status metadata with an optional typed result payload.
 */
export type TaskStatusMetadataWithResult<Result = unknown> = (TaskStatus['metadata'] extends Record<string, unknown>
    ? TaskStatus['metadata']
    : Record<string, unknown>) & {
        /**
         * Child agent result returned from the completed turn.
         */
        result?: Result;
    };

/**
 * Task status augmented with typed metadata.
 */
export type TaskStatusWithResult<Result = unknown> = Omit<TaskStatus, 'metadata'> & {
    metadata?: TaskStatusMetadataWithResult<Result>;
};

/**
 * Snapshot of a child agent task captured when the child completes.
 */
export type InteractiveTaskSnapshot<Result = unknown, Input = unknown> = {
    id: string;
    input: Input;
    status?: TaskStatusWithResult<Result>;
    artifacts?: Artifact[];
};

/**
 * Observation payload emitted when a child agent completes a task.
 */
export type ChildCompletedPayload<Result = unknown, Input = unknown> = {
    token: string;
    childTaskId?: string;
    agentId?: string;
    result: InteractiveTaskSnapshot<Result, Input>;
};

/**
 * helper alias for child completion observations.
 */
export type ChildCompletedObservation<Result = unknown, Input = unknown> = Observation<ChildCompletedPayload<Result, Input>>;

