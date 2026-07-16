export type TaskLifecycleState = 'active' | 'completed' | 'failed' | 'canceled' | 'detached';

export type TaskLifecycle = {
    taskId: string;
    rootTaskId: string;
    parentTaskId?: string;
    ancestorTaskIds: string[];
    state: TaskLifecycleState;
    changedAt?: string;
    reason?: string;
};

const TERMINAL_STATES = new Set<TaskLifecycleState>([
    'completed',
    'failed',
    'canceled',
    'detached',
]);

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function readTaskLifecycle(
    snapshot: unknown,
    fallbackTaskId?: string
): TaskLifecycle | undefined {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
    const raw = (snapshot as { meta?: { taskLifecycle?: unknown } }).meta?.taskLifecycle;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        if (fallbackTaskId === undefined) return undefined;
        return {
            taskId: fallbackTaskId,
            rootTaskId: fallbackTaskId,
            ancestorTaskIds: [],
            state: 'active',
        };
    }
    const fields = raw as Record<string, unknown>;
    const taskId = typeof fields.taskId === 'string' ? fields.taskId : fallbackTaskId;
    if (taskId === undefined) return undefined;
    const state = typeof fields.state === 'string' && (
        fields.state === 'active' || TERMINAL_STATES.has(fields.state as TaskLifecycleState)
    ) ? fields.state as TaskLifecycleState : 'active';
    return {
        taskId,
        rootTaskId: typeof fields.rootTaskId === 'string' ? fields.rootTaskId : taskId,
        ...(typeof fields.parentTaskId === 'string' ? { parentTaskId: fields.parentTaskId } : {}),
        ancestorTaskIds: stringArray(fields.ancestorTaskIds),
        state,
        ...(typeof fields.changedAt === 'string' ? { changedAt: fields.changedAt } : {}),
        ...(typeof fields.reason === 'string' ? { reason: fields.reason } : {}),
    };
}

export function isTaskLifecycleTerminal(lifecycle: TaskLifecycle | undefined): boolean {
    return lifecycle !== undefined && TERMINAL_STATES.has(lifecycle.state);
}

export function writeTaskLifecycle(
    snapshot: Record<string, unknown>,
    lifecycle: TaskLifecycle
): Record<string, unknown> {
    const meta = { ...((snapshot.meta as Record<string, unknown> | undefined) ?? {}) };
    meta.taskLifecycle = lifecycle;
    return { ...snapshot, meta };
}

export function ensureTaskLifecycle(
    snapshot: Record<string, unknown>,
    params: {
        taskId: string;
        rootTaskId?: string;
        parentTaskId?: string;
        ancestorTaskIds?: string[];
    }
): Record<string, unknown> {
    const existing = readTaskLifecycle(snapshot, params.taskId);
    if (existing !== undefined && isTaskLifecycleTerminal(existing)) {
        return writeTaskLifecycle(snapshot, existing);
    }
    const parentTaskId = params.parentTaskId ?? existing?.parentTaskId;
    const ancestorTaskIds = params.ancestorTaskIds ?? existing?.ancestorTaskIds ?? [];
    return writeTaskLifecycle(snapshot, {
        taskId: params.taskId,
        rootTaskId: params.rootTaskId ?? existing?.rootTaskId ?? params.taskId,
        ...(parentTaskId !== undefined ? { parentTaskId } : {}),
        ancestorTaskIds: [...new Set(ancestorTaskIds)],
        state: 'active',
    });
}

export function markTaskLifecycle(
    snapshot: Record<string, unknown>,
    params: {
        taskId: string;
        state: Exclude<TaskLifecycleState, 'active'>;
        changedAt: string;
        reason?: string;
        rootTaskId?: string;
        parentTaskId?: string;
        ancestorTaskIds?: string[];
    }
): Record<string, unknown> {
    const existing = readTaskLifecycle(snapshot, params.taskId);
    // A stale turn must never reactivate or replace a lifecycle claim that was
    // already made by cancellation/detachment coordination.
    if (existing !== undefined && isTaskLifecycleTerminal(existing)) {
        return writeTaskLifecycle(snapshot, existing);
    }
    return writeTaskLifecycle(snapshot, {
        taskId: params.taskId,
        rootTaskId: params.rootTaskId ?? existing?.rootTaskId ?? params.taskId,
        ...(params.parentTaskId ?? existing?.parentTaskId
            ? { parentTaskId: params.parentTaskId ?? existing?.parentTaskId }
            : {}),
        ancestorTaskIds: [...new Set(params.ancestorTaskIds ?? existing?.ancestorTaskIds ?? [])],
        state: params.state,
        changedAt: params.changedAt,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
    });
}
