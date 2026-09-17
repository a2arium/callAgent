export type TaskLifecycleTerminalDetails = {
    tenantId: string;
    taskId: string;
    state: 'completed' | 'failed' | 'canceled' | 'detached';
    reason?: string;
    effectKind: string;
};

/** Expected stop when code attempts to register work under a terminal task branch. */
export class TaskLifecycleTerminalError extends Error {
    public readonly code = 'TASK_LIFECYCLE_TERMINAL';
    public readonly details: TaskLifecycleTerminalDetails;

    constructor(details: TaskLifecycleTerminalDetails) {
        super(`Task ${details.taskId} is ${details.state}; ${details.effectKind} registration was rejected.`);
        this.name = 'TaskLifecycleTerminalError';
        this.details = details;
        Object.setPrototypeOf(this, TaskLifecycleTerminalError.prototype);
    }
}

export function isTaskLifecycleTerminalError(error: unknown): error is TaskLifecycleTerminalError {
    return error instanceof TaskLifecycleTerminalError || (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'TASK_LIFECYCLE_TERMINAL'
    );
}
