/**
 * Internal runtime seam (Phase 0 of the orchestrator-harness plan).
 *
 * This barrel is for INTERNAL use within `@a2arium/callagent-core` only. It is
 * deliberately not re-exported from the package's public `index.ts`, so the
 * public surface stays unchanged and no orchestrator/driver type leaks to agent
 * authors (ADR 0001, acceptance D1).
 */

export type {
    RuntimeDriver,
    RuntimeOperation,
    RuntimeDriverIds,
    RuntimeWakeEvent,
    EnqueueStartParams,
    EnqueueResumeParams,
    EnqueueChildDispatchParams,
    ScheduleTimerParams,
    CancelParams,
    DispatchOutboxParams,
} from './runtimeDriver.js';

export type {
    TurnExecutor,
    TurnTrigger,
    TurnWake,
    SegmentBoundary,
    SegmentTaskStatus,
    SegmentResult,
    RunSegmentParams,
} from './turnExecutor.js';

export { outcomeToBoundary, boundaryToTaskStatus } from './turnExecutor.js';

export {
    InProcessRuntimeDriver,
    wakeEventToTurnWake,
} from './inProcessRuntimeDriver.js';
export type {
    InProcessRuntimeDriverDeps,
    TimerScheduler,
} from './inProcessRuntimeDriver.js';
