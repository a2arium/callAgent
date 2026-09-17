export type TaskTurnSupersededDetails = {
    tenantId: string;
    taskId: string;
    claimId: string;
    fence: string;
    operation: string;
};

/** Expected stop when an expired or replaced task turn attempts a durable mutation. */
export class TaskTurnSupersededError extends Error {
    public readonly code = 'TASK_TURN_SUPERSEDED';
    public readonly details: TaskTurnSupersededDetails;

    constructor(details: TaskTurnSupersededDetails) {
        super(`Task turn ${details.claimId} no longer owns ${details.taskId} during ${details.operation}.`);
        this.name = 'TaskTurnSupersededError';
        this.details = details;
        Object.setPrototypeOf(this, TaskTurnSupersededError.prototype);
    }
}

export function isTaskTurnSupersededError(error: unknown): error is TaskTurnSupersededError {
    return error instanceof TaskTurnSupersededError || (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'TASK_TURN_SUPERSEDED'
    );
}
