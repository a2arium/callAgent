/**
 * RuntimeDriver — the scheduling port.
 *
 * The driver decides *when* work runs and *what wakes it*; the {@link TurnExecutor}
 * decides *what one segment does*. callAgent runs with an in-process driver by
 * default and can opt into a durable orchestrator (e.g. Hatchet) behind the same
 * port. See:
 *   - apps/docs/orchestrator-harness/specs/runtime-driver-port.md
 *   - apps/docs/orchestrator-harness/adr/0001-kernel-seam-and-two-drivers.md
 *
 * INTERNAL framework port — not exported from the public index. No agent code or
 * orchestrator-specific type may leak above this seam (ADR 0001, D1).
 */

/** The logical operations a driver schedules. */
export type RuntimeOperation =
    | 'start'
    | 'resume'
    | 'timer.fire'
    | 'child.dispatch'
    | 'outbox.dispatch'
    | 'cancel';

/** Stable identifiers attached to every driven unit (for routing + observability). */
export type RuntimeDriverIds = {
    tenantId: string;
    taskId: string;
    agentId?: string;
    traceId?: string;
    spanId?: string;
    token?: string;
    /** Deterministic key making each driven unit safe to deliver more than once. */
    idempotencyKey: string;
};

export type RuntimeResultCachePolicy = {
    enabled?: boolean;
    ttlSeconds?: number;
    excludePaths?: string[];
};

/**
 * A wake delivered to a waiting task. Conversation transport stays out of scope;
 * the conversation layer translates a delivered message into a `conversation`
 * wake via {@link RuntimeDriver.enqueueResume} (ADR 0008).
 */
export type RuntimeWakeEvent =
    | { kind: 'input'; token: string; value: unknown }
    | { kind: 'tool'; token: string; result: unknown }
    | { kind: 'child'; token: string; childTaskId: string; output: unknown }
    | {
          kind: 'timer';
          token: string;
          timerId: string;
          dueAt: string;
          firedAt: string;
          reason: 'input_timeout' | 'sleep_due';
          payload?: unknown;
      }
    | { kind: 'external'; token: string; type: string; data: unknown }
    | { kind: 'conversation'; token: string; messageId: string; data: unknown };

export type EnqueueStartParams = RuntimeDriverIds & {
    input: unknown;
    cache?: RuntimeResultCachePolicy;
};
export type EnqueueResumeParams = RuntimeDriverIds & { event: RuntimeWakeEvent };
export type EnqueueChildDispatchParams = RuntimeDriverIds & {
    parentTaskId: string;
    childTaskId: string;
    childAgentId: string;
    input: unknown;
};
export type ScheduleTimerParams = RuntimeDriverIds & {
    token: string;
    fireAt: string;
    kind: 'token_expiry' | 'sleep';
    payload?: unknown;
};
export type CancelParams = RuntimeDriverIds & { reason: string };
export type DispatchOutboxParams = {
    outboxRowId: string;
    eventType: string;
    tenantId?: string;
    taskId?: string;
    agentId?: string;
    traceId?: string;
    spanId?: string;
    token?: string;
};

/**
 * The scheduling seam. `enqueue*` resolve once the unit is *scheduled*, not once
 * it completes; completion is observed via task state / stream events as today.
 */
export type RuntimeDriver = {
    enqueueStart(params: EnqueueStartParams): Promise<void>;
    enqueueResume(params: EnqueueResumeParams): Promise<void>;
    enqueueChildDispatch(params: EnqueueChildDispatchParams): Promise<void>;
    scheduleTimer(params: ScheduleTimerParams): Promise<{ timerId: string }>;
    cancel(params: CancelParams): Promise<void>;
    dispatchOutbox(params: DispatchOutboxParams): Promise<void>;
};
