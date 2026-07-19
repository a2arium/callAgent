import {
    TaskLifecycleTerminalError,
    type TaskLifecycleTerminalDetails,
} from '@a2arium/callagent-types/task-lifecycle-terminal';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import type { SessionManager } from './SessionManager.js';
import {
    ensureTaskLifecycle,
    isTaskLifecycleTerminal,
    markTaskLifecycle,
    readTaskLifecycle,
    type TaskLifecycle,
} from './TaskLifecycle.js';
import { reconcileSnapshotMutation } from './persistence/SnapshotRepository.js';
import { currentTaskTurnClaim } from '../runtime/segmentProcessedKeys.js';
import { assertCurrentTaskTurn } from './TaskTurnCoordinator.js';

export type TaskEffectKind = 'tool' | 'tool.inline' | 'child' | 'child.group' | 'timer' | string;

export type TaskEffectRegistrationResult<T> = {
    value: T;
    lifecycle: TaskLifecycle;
    snapshot: Record<string, unknown>;
};

type RegistrationDecision<T> =
    | { accepted: true; lifecycle: TaskLifecycle; value: T }
    | { accepted: false; lifecycle: TaskLifecycle };

function terminalDetails(
    tenantId: string,
    taskId: string,
    lifecycle: TaskLifecycle,
    effectKind: TaskEffectKind
): TaskLifecycleTerminalDetails {
    return {
        tenantId,
        taskId,
        state: lifecycle.state as TaskLifecycleTerminalDetails['state'],
        ...(lifecycle.reason !== undefined ? { reason: lifecycle.reason } : {}),
        effectKind,
    };
}

/**
 * Copies an already-terminal ancestor into the owner snapshot before registration.
 * If the ancestor terminalizes after this read, the owner registration is the earlier
 * linearized operation and normal recursive branch detachment claims the new effect.
 */
async function reconcileTerminalAncestor(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
}): Promise<void> {
    const owner = await params.session.load(params.tenantId, params.taskId);
    const ownerLifecycle = readTaskLifecycle(owner?.snapshot, params.taskId);
    if (ownerLifecycle === undefined || isTaskLifecycleTerminal(ownerLifecycle)) return;

    for (const ancestorTaskId of ownerLifecycle.ancestorTaskIds) {
        const ancestor = await params.session.load(params.tenantId, ancestorTaskId);
        const ancestorLifecycle = readTaskLifecycle(ancestor?.snapshot, ancestorTaskId);
        if (!isTaskLifecycleTerminal(ancestorLifecycle)) continue;
        const detachedAt = new Date().toISOString();
        await reconcileSnapshotMutation({
            session: params.session,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            operation: 'task.effect.reconcile_terminal_ancestor',
            mutate: ({ snapshot }) => {
                const current = readTaskLifecycle(snapshot, params.taskId);
                if (isTaskLifecycleTerminal(current)) {
                    return { kind: 'noop', value: undefined };
                }
                return {
                    kind: 'write',
                    value: undefined,
                    snapshot: markTaskLifecycle(snapshot, {
                        taskId: params.taskId,
                        state: 'detached',
                        changedAt: detachedAt,
                        reason: `ancestor_${ancestorLifecycle!.state}:${ancestorTaskId}`,
                        rootTaskId: current?.rootTaskId,
                        parentTaskId: current?.parentTaskId,
                        ancestorTaskIds: current?.ancestorTaskIds,
                    }),
                };
            },
        });
        return;
    }
}

/** Register one effect and its control changes at the owner lifecycle CAS boundary. */
export async function registerTaskEffect<T>(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    effectKind: TaskEffectKind;
    operation: string;
    mutate: (current: {
        snapshot: Record<string, unknown>;
        lifecycle: TaskLifecycle;
    }) => { snapshot: Record<string, unknown>; value: T };
}): Promise<TaskEffectRegistrationResult<T>> {
    await reconcileTerminalAncestor(params);
    const activeTurnClaim = currentTaskTurnClaim();
    const result = await reconcileSnapshotMutation<RegistrationDecision<T>>({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: params.operation,
        mutate: ({ snapshot, storageNow }) => {
            if (activeTurnClaim !== undefined) {
                assertCurrentTaskTurn(snapshot, {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    claim: activeTurnClaim,
                    operation: params.operation,
                    storageNow,
                });
            }
            const lifecycleSnapshot = ensureTaskLifecycle(snapshot, { taskId: params.taskId });
            const lifecycle = readTaskLifecycle(lifecycleSnapshot, params.taskId)!;
            if (isTaskLifecycleTerminal(lifecycle)) {
                return {
                    kind: 'noop',
                    value: { accepted: false as const, lifecycle },
                };
            }
            const mutation = params.mutate({ snapshot: lifecycleSnapshot, lifecycle });
            return {
                kind: 'write',
                snapshot: mutation.snapshot,
                value: { accepted: true as const, lifecycle, value: mutation.value },
            };
        },
    });
    if (!result.value.accepted) {
        defaultMetricsRegistry.increment('task_effect_registration_total', {
            effect: params.effectKind,
            status: 'terminal_rejected',
        });
        throw new TaskLifecycleTerminalError(
            terminalDetails(params.tenantId, params.taskId, result.value.lifecycle, params.effectKind)
        );
    }
    defaultMetricsRegistry.increment('task_effect_registration_total', {
        effect: params.effectKind,
        status: 'accepted',
    });
    return {
        value: result.value.value,
        lifecycle: result.value.lifecycle,
        snapshot: result.snapshot,
    };
}

/** Revalidate the owner lifecycle and an optional durable pending token. */
export async function assertTaskEffectActive(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    effectKind: TaskEffectKind;
    token?: string;
    pendingKind?: 'tools' | 'tasks';
}): Promise<TaskLifecycle> {
    await reconcileTerminalAncestor(params);
    const loaded = await params.session.load(params.tenantId, params.taskId);
    const lifecycle = readTaskLifecycle(loaded?.snapshot, params.taskId) ?? {
        taskId: params.taskId,
        rootTaskId: params.taskId,
        ancestorTaskIds: [],
        state: 'active' as const,
    };
    const pending = (loaded?.snapshot as {
        pending?: Record<string, Record<string, unknown>>;
    } | undefined)?.pending;
    const tokenActive = params.token === undefined || params.pendingKind === undefined ||
        pending?.[params.pendingKind]?.[params.token] !== undefined;
    if (isTaskLifecycleTerminal(lifecycle) || !tokenActive) {
        const rejectedLifecycle = isTaskLifecycleTerminal(lifecycle)
            ? lifecycle
            : { ...lifecycle, state: 'detached' as const, reason: 'effect_token_not_pending' };
        throw new TaskLifecycleTerminalError(
            terminalDetails(params.tenantId, params.taskId, rejectedLifecycle, params.effectKind)
        );
    }
    return lifecycle;
}
