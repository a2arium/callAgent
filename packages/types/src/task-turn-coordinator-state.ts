export type TaskTurnCoordinatorStateDetails = {
    tenantId: string;
    taskId: string;
    reason: string;
};

/** Raised when durable turn ownership metadata is missing or internally inconsistent. */
export class TaskTurnCoordinatorStateError extends Error {
    public readonly code = 'TASK_TURN_COORDINATOR_INVALID';
    public readonly details: TaskTurnCoordinatorStateDetails;

    constructor(details: TaskTurnCoordinatorStateDetails) {
        super(`Task turn coordinator for ${details.taskId} is invalid: ${details.reason}`);
        this.name = 'TaskTurnCoordinatorStateError';
        this.details = details;
        Object.setPrototypeOf(this, TaskTurnCoordinatorStateError.prototype);
    }
}

export function isTaskTurnCoordinatorStateError(error: unknown): error is TaskTurnCoordinatorStateError {
    return error instanceof TaskTurnCoordinatorStateError || (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'TASK_TURN_COORDINATOR_INVALID'
    );
}
