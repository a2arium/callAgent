/**
 * TurnExecutor — the segment kernel port.
 *
 * A "segment" is one execution of the existing `runLoop` advanced to the next
 * durable boundary (await / sleep / terminal). Internal `continue` turns run
 * in-process and never cross this boundary. See:
 *   - apps/docs/orchestrator-harness/specs/turn-executor-kernel.md
 *   - apps/docs/orchestrator-harness/adr/0002-durable-execution-mapping.md
 *
 * This is an INTERNAL framework port. It is intentionally not exported from the
 * package's public index; agent authors must never depend on it (ADR 0001).
 */

import type { MentalState } from '../loop/types.js';
import type { TurnOutcome } from '../loop/oneTurn.js';
import type { TurnExecutionParams } from '../orchestration/TurnRunner.js';
import type { TaskContext } from '../shared/types/index.js';
import type { TaskEntity } from '../orchestration/types.js';
import type { RuntimeWakeEvent } from './runtimeDriver.js';

/** Pre-built runTurn invocation; skips wake applicator (snapshot already prepared). */
export type PreparedTurnInvocation = {
    ctx: TaskContext;
    turnParams: TurnExecutionParams;
    initialM?: MentalState;
    snapshot?: Record<string, unknown>;
};

/** How a segment was woken. Mirrors the trigger taxonomy of the runtime. */
export type TurnTrigger =
    | 'start'
    | 'resume'
    | 'tool'
    | 'child'
    | 'timer'
    | 'event'
    | 'conversation';

/**
 * The wake handed to the kernel. `start` carries raw input; every other trigger
 * carries a typed {@link RuntimeWakeEvent}.
 */
export type TurnWake =
    | { trigger: 'start'; input: unknown }
    | { trigger: 'resume'; event: RuntimeWakeEvent }
    | { trigger: 'tool'; event: RuntimeWakeEvent }
    | { trigger: 'child'; event: RuntimeWakeEvent }
    | { trigger: 'timer'; event: RuntimeWakeEvent }
    | { trigger: 'event'; event: RuntimeWakeEvent }
    | { trigger: 'conversation'; event: RuntimeWakeEvent };

/**
 * The durable boundary a segment stops at. `continue` is NOT a boundary: it is
 * consumed inside the segment by `runLoop` and never returned to the driver.
 *
 * `paused` represents a non-terminal stop that is also not an await — today this
 * is a budget/latency cutoff where `runLoop` returns `continue`. The driver must
 * reschedule the task to make further progress.
 *
 * `sleep` is not produced by the in-process kernel today (token expiry rides on
 * `await_input.expiresAt`); it is kept in the union for drivers that synthesize
 * durable sleeps (ADR 0003).
 */
export type SegmentBoundary =
    | { kind: 'await_input'; token: string; expiresAt?: string }
    | { kind: 'await_tool'; token: string }
    | {
          kind: 'await_child';
          token: string;
          expiresAt?: string;
          timeoutMs?: number;
          childTaskId?: string;
          agentId?: string;
      }
    | { kind: 'await_event'; token: string }
    | { kind: 'sleep'; token: string; fireAt: string; timerId?: string; payload?: unknown }
    | { kind: 'paused'; reason: string }
    | { kind: 'canceled'; reason?: string }
    | { kind: 'complete'; result?: unknown }
    | { kind: 'fail'; error: unknown };

/** Coarse task status after a segment, aligned to the runtime's task states. */
export type SegmentTaskStatus =
    | 'working'
    | 'input-required'
    | 'completed'
    | 'failed'
    | 'canceled';

export type SegmentResult = {
    tenantId: string;
    taskId: string;
    agentId?: string;
    boundary: SegmentBoundary;
    taskStatus: SegmentTaskStatus;
    traceId?: string;
    turnTraceId?: string;
    /** Populated when the segment ran via a prepared turn invocation. */
    taskEntity?: TaskEntity;
};

export type RunSegmentParams = {
    tenantId: string;
    taskId: string;
    agentId?: string;
    wake: TurnWake;
    idempotencyKey: string;
    /** When set, invoke runTurn directly without wake applicator mutation. */
    prepared?: PreparedTurnInvocation;
};

/**
 * The shared kernel both drivers schedule against. Implementations wrap the
 * existing loop machinery (`TurnRunner` / `TaskExecutor` / `runLoop`); they must
 * not re-implement APLRET cognition.
 */
export type TurnExecutor = {
    runSegment(params: RunSegmentParams): Promise<SegmentResult>;
};

/**
 * Pure mapping from an internal `TurnOutcome` to a driver-facing
 * {@link SegmentBoundary}. Kept side-effect free so it is trivially testable and
 * reusable by any driver.
 *
 * @param outcome the outcome returned by the loop at the end of a segment.
 * @param opts.expiresAt optional token expiry, surfaced for `await_input`.
 */
export function outcomeToBoundary(
    outcome: TurnOutcome,
    opts?: { expiresAt?: string }
): SegmentBoundary {
    switch (outcome.kind) {
        case 'await_input':
            return opts?.expiresAt !== undefined
                ? { kind: 'await_input', token: outcome.token, expiresAt: opts.expiresAt }
                : { kind: 'await_input', token: outcome.token };
        case 'await_tool':
            return { kind: 'await_tool', token: outcome.token };
        case 'await_child':
            return { kind: 'await_child', token: outcome.token };
        case 'await_event':
            return { kind: 'await_event', token: outcome.token };
        case 'complete':
            return { kind: 'complete', result: outcome.result };
        case 'fail':
            return { kind: 'fail', error: outcome.error ?? outcome.reason };
        case 'continue':
            // The loop yielded without reaching an await/terminal boundary —
            // today only when the turn budget or latency cap is hit.
            return { kind: 'paused', reason: 'budget_or_latency' };
    }
}

/** Pure mapping from a {@link SegmentBoundary} to a coarse task status. */
export function boundaryToTaskStatus(boundary: SegmentBoundary): SegmentTaskStatus {
    switch (boundary.kind) {
        case 'await_input':
            return 'input-required';
        case 'await_tool':
        case 'await_child':
        case 'await_event':
        case 'sleep':
        case 'paused':
            return 'working';
        case 'canceled':
            return 'canceled';
        case 'complete':
            return 'completed';
        case 'fail':
            return 'failed';
    }
}
