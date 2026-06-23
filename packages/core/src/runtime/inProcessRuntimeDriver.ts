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
import type {
    CancelParams,
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
    private readonly turnExecutor: TurnExecutor;
    private readonly childDispatcher?: (params: EnqueueChildDispatchParams) => Promise<void>;
    private readonly outboxDispatcher?: (params: DispatchOutboxParams) => Promise<void>;
    private readonly onCancel?: (params: CancelParams) => Promise<void> | void;
    private readonly onSegmentError: (error: unknown, params: RunSegmentParams) => void;
    private readonly now: () => number;
    private readonly scheduler: TimerScheduler;

    /** In-flight background work, so tests and shutdown can await quiescence. */
    private readonly inFlight = new Set<Promise<unknown>>();
    /** Scheduled timers keyed by timerId, plus a reverse index per task. */
    private readonly timers = new Map<string, unknown>();
    private readonly timersByTask = new Map<string, Set<string>>();

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
        const tracked: Promise<unknown> = this.turnExecutor
            .runSegment(params)
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
        const timerId = deriveRuntimeTimerId({
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
            fireAt: params.fireAt,
            kind: params.kind,
        });
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
            void this.enqueueResume({
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                traceId: params.traceId,
                spanId: params.spanId,
                token: params.token,
                idempotencyKey: deriveRuntimeTimerIdempotencyKey({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    token: params.token,
                    timerId,
                }),
                event,
            });
        }, delayMs);

        this.timers.set(timerId, handle);
        let perTask = this.timersByTask.get(params.taskId);
        if (perTask === undefined) {
            perTask = new Set<string>();
            this.timersByTask.set(params.taskId, perTask);
        }
        perTask.add(timerId);
        return { timerId };
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
        while (this.inFlight.size > 0) {
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
    }

    private runSegmentInBackground(params: RunSegmentParams): void {
        const tracked: Promise<unknown> = this.turnExecutor
            .runSegment(params)
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
        }
        this.timersByTask.delete(taskId);
    }

    private forgetTimer(taskId: string, timerId: string): void {
        this.timers.delete(timerId);
        const perTask = this.timersByTask.get(taskId);
        if (perTask !== undefined) {
            perTask.delete(timerId);
            if (perTask.size === 0) {
                this.timersByTask.delete(taskId);
            }
        }
    }
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
