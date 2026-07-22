/**
 * InProcessRuntimeDriver — the default driver.
 *
 * Reproduces today's runtime scheduling behavior: start/resume run immediately
 * as tracked background work, timers use the local clock, and outbox dispatch is
 * left to the existing poller. It requires no external service, so local dev and
 * the full test suite run unchanged (ADR 0001, acceptance D5).
 *
 * INTERNAL — not exported from the public index.
 */

import { logger } from '@a2arium/callagent-utils';
import type { RunnableTurnRequest } from '@a2arium/callagent-memory-engine';
import type { SessionManager } from '../orchestration/SessionManager.js';
import type {
    CancelParams,
    CancelTimerParams,
    DispatchOutboxParams,
    EnqueueChildDispatchParams,
    EnqueueResumeParams,
    EnqueueStartParams,
    RuntimeDriver,
    RuntimeWakeEvent,
    ScheduleTimerParams,
} from './runtimeDriver.js';
import type {
    PreparedTurnInvocation,
    RunSegmentParams,
    SegmentResult,
    TurnExecutor,
    TurnWake,
} from './turnExecutor.js';
import {
    deriveRuntimeTimerId,
    deriveRuntimeTimerIdempotencyKey,
    timerKindToReason,
    RuntimeTimerRepository,
    type RuntimeTimerKind,
} from './runtimeTimer.js';

const log = logger.createLogger({ prefix: 'InProcessRuntimeDriver' });

/** Minimal injectable scheduler so timer behavior is deterministic in tests. */
export type TimerScheduler = {
    set(cb: () => void, ms: number): unknown;
    clear(handle: unknown): void;
};

const defaultScheduler: TimerScheduler = {
    set: (cb, ms) => setTimeout(cb, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type InProcessRuntimeDriverDeps = {
    /** The shared kernel that actually advances a task by one segment. */
    turnExecutor: TurnExecutor;
    /**
     * Child dispatch wiring (existing engine/A2A path). Phase 0 keeps this as an
     * injected delegate rather than re-implementing dispatch.
     */
    childDispatcher?: (params: EnqueueChildDispatchParams) => Promise<void>;
    /**
     * Outbox dispatch wiring. In-process this is owned by the existing poller, so
     * the default is a no-op (ADR 0006 / Phase 1 changes this).
     */
    outboxDispatcher?: (params: DispatchOutboxParams) => Promise<void>;
    /** Optional cancellation hook (full semantics: ADR 0010, later phases). */
    onCancel?: (params: CancelParams) => Promise<void> | void;
    /** Invoked when a background segment rejects; defaults to logging. */
    onSegmentError?: (error: unknown, params: RunSegmentParams) => void;
    /** Clock used to compute timer delays; injectable for tests. */
    now?: () => number;
    /** Timer scheduler; injectable for tests. */
    scheduler?: TimerScheduler;
    /** SQL timer repository used to survive runtime recreation. */
    runtimeTimers?: RuntimeTimerRepository;
    /** Root-run expiry bypasses segment execution and claims task terminality directly. */
    onTaskRunTimeout?: (params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        token: string;
        dueAt: string;
        payload?: unknown;
    }) => Promise<void>;
    timerReconcileIntervalMs?: number;
    /** Durable source for queued turn generations that need a scheduling nudge. */
    sessionManager?: SessionManager;
    turnReconcileIntervalMs?: number;
    random?: () => number;
};

/** Maps a driver wake event to the kernel's {@link TurnWake}. */
export function wakeEventToTurnWake(event: RuntimeWakeEvent): TurnWake {
    switch (event.kind) {
        case 'input':
            return { trigger: 'resume', event };
        case 'tool':
            return { trigger: 'tool', event };
        case 'child':
            return { trigger: 'child', event };
        case 'timer':
            return { trigger: 'timer', event };
        case 'external':
            return { trigger: 'event', event };
        case 'conversation':
            return { trigger: 'conversation', event };
    }
}

export class InProcessRuntimeDriver implements RuntimeDriver {
    readonly surface = 'in_process' as const;
    private readonly turnExecutor: TurnExecutor;
    private readonly childDispatcher?: (params: EnqueueChildDispatchParams) => Promise<void>;
    private readonly outboxDispatcher?: (params: DispatchOutboxParams) => Promise<void>;
    private readonly onCancel?: (params: CancelParams) => Promise<void> | void;
    private readonly onSegmentError: (error: unknown, params: RunSegmentParams) => void;
    private readonly now: () => number;
    private readonly scheduler: TimerScheduler;
    private readonly runtimeTimers?: RuntimeTimerRepository;
    private readonly onTaskRunTimeout?: InProcessRuntimeDriverDeps['onTaskRunTimeout'];
    private readonly sessionManager?: SessionManager;
    private readonly recoveryKeys = new Set<string>();
    private recoveryScan?: Promise<void>;

    /** In-flight background work, so tests and shutdown can await quiescence. */
    private readonly inFlight = new Set<Promise<unknown>>();
    /** Scheduled timers keyed by timerId, plus a reverse index per task. */
    private readonly timers = new Map<string, unknown>();
    private readonly timersByTask = new Map<string, Set<string>>();
    private readonly timerMeta = new Map<string, { tenantId: string; taskId: string; token: string }>();

    constructor(deps: InProcessRuntimeDriverDeps) {
        this.turnExecutor = deps.turnExecutor;
        this.childDispatcher = deps.childDispatcher;
        this.outboxDispatcher = deps.outboxDispatcher;
        this.onCancel = deps.onCancel;
        this.onSegmentError =
            deps.onSegmentError ??
            ((error, params) =>
                log.error('Background segment failed', {
                    taskId: params.taskId,
                    trigger: params.wake.trigger,
                    error: error instanceof Error ? error.message : String(error),
                }));
        this.now = deps.now ?? (() => Date.now());
        this.scheduler = deps.scheduler ?? defaultScheduler;
        this.runtimeTimers = deps.runtimeTimers;
        this.onTaskRunTimeout = deps.onTaskRunTimeout;
        this.sessionManager = deps.sessionManager;
        if (this.runtimeTimers !== undefined) {
            void this.reconcilePersistedTimers().catch((error) =>
                log.warn('Persisted timer reconciliation failed', {
                    error: error instanceof Error ? error.message : String(error),
                })
            );
            const interval = setInterval(
                () => void this.reconcilePersistedTimers().catch((error) =>
                    log.warn('Periodic timer reconciliation failed', {
                        error: error instanceof Error ? error.message : String(error),
                    })
                ),
                deps.timerReconcileIntervalMs ?? 1_000
            );
            interval.unref?.();
        }
        if (this.sessionManager !== undefined) {
            const random = deps.random ?? Math.random;
            const baseIntervalMs = deps.turnReconcileIntervalMs ?? 5_000;
            const reconcile = () => {
                if (this.recoveryScan !== undefined) return;
                const scan = this.reconcileRunnableTurnRequests()
                    .catch((error) => log.warn('Runnable turn reconciliation failed', {
                        error: error instanceof Error ? error.message : String(error),
                    }))
                    .finally(() => {
                        if (this.recoveryScan === scan) this.recoveryScan = undefined;
                    });
                this.recoveryScan = scan;
            };
            reconcile();
            const interval = setInterval(reconcile, Math.max(250, Math.round(baseIntervalMs * (0.75 + random() * 0.5))));
            interval.unref?.();
        }
    }

    /** Composition-root access for worker bootstrap (Phase 0.4). */
    getTurnExecutor(): TurnExecutor {
        return this.turnExecutor;
    }

    async enqueueStart(params: EnqueueStartParams): Promise<void> {
        this.runSegmentInBackground({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            idempotencyKey: params.idempotencyKey,
            wake: { trigger: 'start', input: params.input },
        });
    }

    async enqueueResume(params: EnqueueResumeParams): Promise<void> {
        this.runSegmentInBackground({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            idempotencyKey: params.idempotencyKey,
            wake: wakeEventToTurnWake(params.event),
        });
    }

    /**
     * Synchronous start: awaits segment completion. Used when the caller must
     * observe the turn result before returning (e.g. `startTask` loop mode).
     */
    async enqueueStartSync(
        params: EnqueueStartParams & { prepared?: PreparedTurnInvocation }
    ): Promise<SegmentResult> {
        return this.runSegmentAwait({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            idempotencyKey: params.idempotencyKey,
            wake: { trigger: 'start', input: params.input },
            prepared: params.prepared,
        });
    }

    /**
     * Synchronous resume: awaits segment completion. Preserves today's awaited
     * auto-resume paths while routing through the in-process driver.
     */
    async enqueueResumeSync(
        params: EnqueueResumeParams & { prepared?: PreparedTurnInvocation }
    ): Promise<SegmentResult> {
        return this.runSegmentAwait({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            idempotencyKey: params.idempotencyKey,
            wake: wakeEventToTurnWake(params.event),
            prepared: params.prepared,
        });
    }

    /** Runs one segment to completion (tracked for `waitForIdle`). */
    async runSegmentAwait(params: RunSegmentParams): Promise<SegmentResult> {
        const tracked: Promise<unknown> = this.turnExecutor.runSegment(params)
            .catch((error: unknown) => {
                this.onSegmentError(error, params);
                throw error;
            })
            .finally(() => {
                this.inFlight.delete(tracked);
            });
        this.inFlight.add(tracked);
        return tracked as Promise<SegmentResult>;
    }

    async enqueueChildDispatch(params: EnqueueChildDispatchParams): Promise<void> {
        if (!this.childDispatcher) {
            throw new Error(
                'InProcessRuntimeDriver.enqueueChildDispatch called without a childDispatcher'
            );
        }
        await this.childDispatcher(params);
    }

    async scheduleTimer(params: ScheduleTimerParams): Promise<{ timerId: string }> {
        const persisted = await this.runtimeTimers?.schedule({ ...params, rootTaskId: params.taskId });
        const timerId = persisted?.timerId ?? deriveRuntimeTimerId({
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
            fireAt: params.fireAt,
            kind: params.kind,
        });
        if (persisted === undefined || (persisted.status !== 'fired' && persisted.status !== 'canceled')) {
            this.scheduleLocalTimer(params, timerId);
        }
        return { timerId };
    }

    private scheduleLocalTimer(params: ScheduleTimerParams, timerId: string): void {
        if (this.timers.has(timerId)) return;
        const delayMs = Math.max(0, Date.parse(params.fireAt) - this.now());

        const handle = this.scheduler.set(() => {
            const firedAt = new Date(this.now()).toISOString();
            this.forgetTimer(params.taskId, timerId);
            const event: RuntimeWakeEvent = {
                kind: 'timer',
                token: params.token,
                timerId,
                dueAt: params.fireAt,
                firedAt,
                reason: timerKindToReason(params.kind),
                payload: params.payload,
            };
            this.trackTimerFire(params, timerId, event);
        }, delayMs);

        this.timers.set(timerId, handle);
        let perTask = this.timersByTask.get(params.taskId);
        if (perTask === undefined) {
            perTask = new Set<string>();
            this.timersByTask.set(params.taskId, perTask);
        }
        perTask.add(timerId);
        this.timerMeta.set(timerId, {
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
        });
    }

    private async fireTimer(
        params: ScheduleTimerParams,
        timerId: string,
        event: Extract<RuntimeWakeEvent, { kind: 'timer' }>
    ): Promise<void> {
        const lease = await this.runtimeTimers?.acquireFireLease({
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
            timerId,
            leaseTtlMs: 60_000,
        });
        if (this.runtimeTimers !== undefined && lease === null) return;
        try {
            if (params.kind === 'task_run_timeout') {
                if (this.onTaskRunTimeout === undefined) {
                    throw new Error('TASK_RUN_TIMEOUT_HANDLER_MISSING');
                }
                await this.onTaskRunTimeout({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                    token: params.token,
                    dueAt: params.fireAt,
                    ...(params.payload !== undefined ? { payload: params.payload } : {}),
                });
            } else {
                await this.runSegmentAwait({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    idempotencyKey: deriveRuntimeTimerIdempotencyKey({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        token: params.token,
                        timerId,
                    }),
                    wake: wakeEventToTurnWake(event),
                });
            }
            if (lease !== undefined && lease !== null) {
                await this.runtimeTimers?.markFired({
                    id: lease.timer.id,
                    fireLeaseId: lease.fireLeaseId,
                    firedAt: new Date(event.firedAt),
                });
            }
        } catch (error) {
            if (lease !== undefined && lease !== null) {
                await this.runtimeTimers?.markFailed({
                    id: lease.timer.id,
                    fireLeaseId: lease.fireLeaseId,
                    error,
                });
            }
            throw error;
        }
    }

    private trackTimerFire(
        params: ScheduleTimerParams,
        timerId: string,
        event: Extract<RuntimeWakeEvent, { kind: 'timer' }>
    ): void {
        const tracked = this.fireTimer(params, timerId, event)
            .catch((error) => {
                log.warn('Timer fire failed', {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    token: params.token,
                    timerId,
                    error: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => this.inFlight.delete(tracked));
        this.inFlight.add(tracked);
    }

    private async reconcilePersistedTimers(): Promise<void> {
        const scheduled = await this.runtimeTimers?.listScheduled({ take: 1_000 });
        for (const timer of scheduled ?? []) {
            this.scheduleLocalTimer(
                {
                    tenantId: timer.tenantId,
                    taskId: timer.taskId,
                    agentId: timer.agentId ?? undefined,
                    token: timer.token,
                    fireAt: timer.dueAt.toISOString(),
                    kind: timer.kind as RuntimeTimerKind,
                    payload: timer.payload ?? undefined,
                    idempotencyKey: timer.idempotencyKey,
                },
                timer.timerId
            );
        }
    }

    async cancelTimer(params: CancelTimerParams): Promise<void> {
        for (const [timerId, meta] of this.timerMeta.entries()) {
            if (
                meta.tenantId === params.tenantId &&
                meta.taskId === params.taskId &&
                meta.token === params.token
            ) {
                const handle = this.timers.get(timerId);
                if (handle !== undefined) this.scheduler.clear(handle);
                this.forgetTimer(meta.taskId, timerId);
            }
        }
        await this.runtimeTimers?.cancelTaskTimers(params);
    }

    async cancel(params: CancelParams): Promise<void> {
        this.clearTimersForTask(params.taskId);
        if (this.onCancel) {
            await this.onCancel(params);
        }
    }

    async dispatchOutbox(params: DispatchOutboxParams): Promise<void> {
        if (this.outboxDispatcher) {
            await this.outboxDispatcher(params);
        }
        // Otherwise the existing OutboxPublisher poller owns delivery (Phase 0).
    }

    /** Awaits all in-flight background segments (re-checking until quiescent). */
    async waitForIdle(): Promise<void> {
        while (this.inFlight.size > 0 || this.recoveryScan !== undefined || this.recoveryKeys.size > 0) {
            if (this.recoveryScan !== undefined) await this.recoveryScan;
            await Promise.allSettled([...this.inFlight]);
        }
    }

    /** Clears all scheduled timers (e.g. on shutdown). Does not await segments. */
    clearAllTimers(): void {
        for (const handle of this.timers.values()) {
            this.scheduler.clear(handle);
        }
        this.timers.clear();
        this.timersByTask.clear();
        this.timerMeta.clear();
    }

    private runSegmentInBackground(params: RunSegmentParams): void {
        const tracked: Promise<unknown> = this.turnExecutor.runSegment(params)
            .then(
                () => undefined,
                (error: unknown) => {
                    this.onSegmentError(error, params);
                }
            )
            .finally(() => {
                this.inFlight.delete(tracked);
            });
        this.inFlight.add(tracked);
    }

    private async reconcileRunnableTurnRequests(): Promise<void> {
        if (!this.sessionManager) return;
        let cursor: { updatedAt: string; tenantId: string; sessionId: string } | undefined;
        do {
            const rows = await this.sessionManager.listRunnableTurnRequests({
                ...(cursor ? { cursor } : {}),
                limit: 100,
            });
            await runWithConcurrency(rows, 4, (row) => this.scheduleRecoveredTurn(row));
            const last = rows.at(-1);
            cursor = last ? { updatedAt: last.updatedAt, tenantId: last.tenantId, sessionId: last.sessionId } : undefined;
            if (rows.length < 100) break;
        } while (cursor !== undefined);
    }

    private async scheduleRecoveredTurn(row: RunnableTurnRequest): Promise<void> {
        if (row.runtimeSurface === 'hatchet') return;
        const key = `${row.tenantId}:${row.sessionId}:${row.generation}:${row.deliveryKey}`;
        if (this.recoveryKeys.has(key)) return;
        this.recoveryKeys.add(key);
        try {
            const result = await this.runSegmentAwait({
                tenantId: row.tenantId,
                taskId: row.sessionId,
                agentId: row.agentId,
                idempotencyKey: row.deliveryKey,
                runtimeSurface: 'in_process',
                recoveryGeneration: row.generation,
                wake: {
                    trigger: 'resume',
                    event: { kind: 'external', token: row.deliveryKey, type: 'task.turn.available', data: undefined },
                },
            });
            if (result.turnDisposition === 'queued') {
                log.debug('Recovered turn request remains owned by another worker', {
                    tenantId: row.tenantId,
                    taskId: row.sessionId,
                    generation: row.generation,
                });
            }
        } finally {
            this.recoveryKeys.delete(key);
        }
    }

    private clearTimersForTask(taskId: string): void {
        const perTask = this.timersByTask.get(taskId);
        if (perTask === undefined) {
            return;
        }
        for (const timerId of perTask) {
            const handle = this.timers.get(timerId);
            if (handle !== undefined) {
                this.scheduler.clear(handle);
                this.timers.delete(timerId);
            }
            this.timerMeta.delete(timerId);
        }
        this.timersByTask.delete(taskId);
    }

    private forgetTimer(taskId: string, timerId: string): void {
        this.timers.delete(timerId);
        this.timerMeta.delete(timerId);
        const perTask = this.timersByTask.get(taskId);
        if (perTask !== undefined) {
            perTask.delete(timerId);
            if (perTask.size === 0) {
                this.timersByTask.delete(taskId);
            }
        }
    }
}

async function runWithConcurrency<T>(
    rows: T[],
    concurrency: number,
    worker: (row: T) => Promise<void>
): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
        for (;;) {
            const current = index++;
            if (current >= rows.length) return;
            await worker(rows[current]!);
        }
    });
    await Promise.all(workers);
}

/** Phase 0 sync extensions — not part of the async `RuntimeDriver` port (see driver-sync-api.md). */
export type SyncRuntimeDriver = RuntimeDriver & {
    enqueueStartSync(
        params: EnqueueStartParams & { prepared?: PreparedTurnInvocation }
    ): Promise<SegmentResult>;
    enqueueResumeSync(
        params: EnqueueResumeParams & { prepared?: PreparedTurnInvocation }
    ): Promise<SegmentResult>;
};

export function isSyncRuntimeDriver(driver: RuntimeDriver): driver is SyncRuntimeDriver {
    const candidate = driver as SyncRuntimeDriver;
    return (
        typeof candidate.enqueueStartSync === 'function' &&
        typeof candidate.enqueueResumeSync === 'function'
    );
}
