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

export type RootRunDeadline = {
    timeoutMs: number;
    startedAt: string;
    expiresAt: string;
    source: string;
    timerToken: string;
};

export type DurableTaskTerminal = {
    taskId: string;
    state: 'completed' | 'failed' | 'canceled';
    claimedAt: string;
    deliveryKey: string;
    enqueuedAt?: string;
    status: {
        state: 'completed' | 'failed' | 'canceled';
        timestamp: string;
        message?: { role: 'agent'; parts: Array<{ type: 'text'; text: string }> };
        metadata?: Record<string, unknown>;
    };
    turnClaim?: {
        claimId: string;
        fence: string;
        generation: string;
        turnSeq: number;
    };
};

export function markDurableTaskTerminalEnqueued(
    snapshot: Record<string, unknown>,
    deliveryKey: string,
    enqueuedAt: string
): Record<string, unknown> {
    const terminal = readDurableTaskTerminal(snapshot);
    if (terminal === undefined || terminal.deliveryKey !== deliveryKey || terminal.enqueuedAt !== undefined) {
        return snapshot;
    }
    return writeDurableTaskTerminal(snapshot, { ...terminal, enqueuedAt });
}

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

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function readRootRunDeadline(snapshot: unknown): RootRunDeadline | undefined {
    const root = recordValue(snapshot);
    const meta = recordValue(root?.meta);
    const raw = recordValue(meta?.rootRunDeadline);
    if (
        typeof raw?.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0 ||
        typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt)) ||
        typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt)) ||
        typeof raw.source !== 'string'
    ) {
        return undefined;
    }
    return {
        timeoutMs: Math.trunc(raw.timeoutMs),
        startedAt: raw.startedAt,
        expiresAt: raw.expiresAt,
        source: raw.source,
        timerToken: typeof raw.timerToken === 'string' && raw.timerToken.length > 0
            ? raw.timerToken
            : 'root-run-timeout',
    };
}

export function writeRootRunDeadline(
    snapshot: Record<string, unknown>,
    deadline: RootRunDeadline
): Record<string, unknown> {
    const meta = { ...(recordValue(snapshot.meta) ?? {}) };
    meta.rootRunDeadline = deadline;
    return { ...snapshot, meta };
}

export function readDurableTaskTerminal(snapshot: unknown): DurableTaskTerminal | undefined {
    const root = recordValue(snapshot);
    const meta = recordValue(root?.meta);
    const raw = recordValue(meta?.taskTerminal);
    const status = recordValue(raw?.status);
    const state = raw?.state;
    if (
        typeof raw?.taskId !== 'string' ||
        (state !== 'completed' && state !== 'failed' && state !== 'canceled') ||
        typeof raw.claimedAt !== 'string' ||
        typeof raw.deliveryKey !== 'string' ||
        status?.state !== state ||
        typeof status.timestamp !== 'string'
    ) {
        return undefined;
    }
    return raw as unknown as DurableTaskTerminal;
}

export function writeDurableTaskTerminal(
    snapshot: Record<string, unknown>,
    terminal: DurableTaskTerminal
): Record<string, unknown> {
    const meta = { ...(recordValue(snapshot.meta) ?? {}) };
    meta.taskTerminal = terminal;
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

export type TaskTerminalDisposition = 'committed' | 'matching_replay' | 'competing_terminal';

export function claimTaskTerminalInSnapshot(
    snapshot: Record<string, unknown>,
    params: {
        taskId: string;
        state: 'completed' | 'failed' | 'canceled';
        claimedAt: string;
        reason?: string;
        status: DurableTaskTerminal['status'];
        turnClaim?: DurableTaskTerminal['turnClaim'];
    }
): {
    snapshot: Record<string, unknown>;
    terminal: DurableTaskTerminal;
    disposition: TaskTerminalDisposition;
    changed: boolean;
} {
    const lifecycle = readTaskLifecycle(snapshot, params.taskId);
    const existingTerminal = readDurableTaskTerminal(snapshot);
    if (lifecycle !== undefined && isTaskLifecycleTerminal(lifecycle)) {
        const same = lifecycle.state === params.state;
        const terminalState: DurableTaskTerminal['state'] =
            lifecycle.state === 'completed' || lifecycle.state === 'failed' || lifecycle.state === 'canceled'
                ? lifecycle.state
                : 'canceled';
        const terminal = existingTerminal ?? {
            taskId: params.taskId,
            state: terminalState,
            claimedAt: lifecycle.changedAt ?? params.claimedAt,
            deliveryKey: `${params.taskId}:terminal:${lifecycle.state}`,
            status: same ? params.status : {
                state: terminalState,
                timestamp: lifecycle.changedAt ?? params.claimedAt,
                ...(lifecycle.reason !== undefined ? { metadata: { reason: lifecycle.reason } } : {}),
            },
        } satisfies DurableTaskTerminal;
        if (existingTerminal !== undefined) {
            return {
                snapshot,
                terminal,
                disposition: same ? 'matching_replay' : 'competing_terminal',
                changed: false,
            };
        }
        return {
            snapshot: writeDurableTaskTerminal(snapshot, terminal),
            terminal,
            disposition: same ? 'matching_replay' : 'competing_terminal',
            changed: true,
        };
    }

    const lifecycleSnapshot = markTaskLifecycle(snapshot, {
        taskId: params.taskId,
        state: params.state,
        changedAt: params.claimedAt,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        rootTaskId: lifecycle?.rootTaskId,
        parentTaskId: lifecycle?.parentTaskId,
        ancestorTaskIds: lifecycle?.ancestorTaskIds,
    });
    const terminal: DurableTaskTerminal = {
        taskId: params.taskId,
        state: params.state,
        claimedAt: params.claimedAt,
        deliveryKey: `${params.taskId}:terminal:${params.state}`,
        status: params.status,
        ...(params.turnClaim ? { turnClaim: params.turnClaim } : {}),
    };
    return {
        snapshot: writeDurableTaskTerminal(lifecycleSnapshot, terminal),
        terminal,
        disposition: 'committed',
        changed: true,
    };
}
