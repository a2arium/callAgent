export type TaskReplyDeliveryMode = 'stream' | 'buffer';

export const TASK_REPLY_DELIVERY_MODE_CONFLICT = 'TASK_REPLY_DELIVERY_MODE_CONFLICT';

type SnapshotMeta = Record<string, unknown> & {
    replyDeliveryMode?: unknown;
};

export class TaskReplyDeliveryModeConflictError extends Error {
    readonly code = TASK_REPLY_DELIVERY_MODE_CONFLICT;

    constructor(
        readonly existingMode: TaskReplyDeliveryMode,
        readonly requestedMode: TaskReplyDeliveryMode
    ) {
        super(
            `${TASK_REPLY_DELIVERY_MODE_CONFLICT}: task reply delivery mode is already ` +
            `${existingMode}; cannot change it to ${requestedMode}.`
        );
        this.name = 'TaskReplyDeliveryModeConflictError';
        Object.setPrototypeOf(this, TaskReplyDeliveryModeConflictError.prototype);
    }
}

export function taskReplyDeliveryModeFromStreaming(
    isStreaming: boolean
): TaskReplyDeliveryMode {
    return isStreaming ? 'stream' : 'buffer';
}

export function isTaskReplyStreaming(mode: TaskReplyDeliveryMode): boolean {
    return mode === 'stream';
}

export function readTaskReplyDeliveryMode(
    snapshot: Record<string, unknown> | undefined
): TaskReplyDeliveryMode | undefined {
    const meta = snapshot?.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    const value = (meta as SnapshotMeta).replyDeliveryMode;
    return value === 'stream' || value === 'buffer' ? value : undefined;
}

export function ensureTaskReplyDeliveryMode(
    snapshot: Record<string, unknown>,
    requestedMode: TaskReplyDeliveryMode
): {
    snapshot: Record<string, unknown>;
    mode: TaskReplyDeliveryMode;
    changed: boolean;
} {
    const existingMode = readTaskReplyDeliveryMode(snapshot);
    if (existingMode !== undefined) {
        if (existingMode !== requestedMode) {
            throw new TaskReplyDeliveryModeConflictError(existingMode, requestedMode);
        }
        return { snapshot, mode: existingMode, changed: false };
    }

    const meta = snapshot.meta !== null &&
        typeof snapshot.meta === 'object' &&
        !Array.isArray(snapshot.meta)
        ? snapshot.meta as Record<string, unknown>
        : {};

    return {
        snapshot: {
            ...snapshot,
            meta: {
                ...meta,
                replyDeliveryMode: requestedMode,
            },
        },
        mode: requestedMode,
        changed: true,
    };
}
