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
    RuntimeResultCachePolicy,
    RuntimeWakeEvent,
    EnqueueStartParams,
    EnqueueResumeParams,
    EnqueueChildDispatchParams,
    ScheduleTimerParams,
    CancelTimerParams,
    CancelParams,
    DispatchOutboxParams,
} from './runtimeDriver.js';

export {
    RuntimeTimerRepository,
    deriveRuntimeTimerId,
    deriveRuntimeTimerIdempotencyKey,
    timerKindToReason,
    timerRecordToWake,
} from './runtimeTimer.js';
export type {
    RuntimeTimerKind,
    RuntimeTimerStatus,
    RuntimeTimerRecord,
    RuntimeTimerScheduleParams,
    RuntimeTimerFireLease,
    RuntimeTimerPrisma,
    TimerExpiredReason,
} from './runtimeTimer.js';

export type {
    TurnExecutor,
    TurnTrigger,
    TurnWake,
    SegmentBoundary,
    SegmentTaskStatus,
    SegmentResult,
    RunSegmentParams,
    PreparedTurnInvocation,
} from './turnExecutor.js';

export { outcomeToBoundary, boundaryToTaskStatus } from './turnExecutor.js';

export {
    InProcessRuntimeDriver,
    wakeEventToTurnWake,
    isSyncRuntimeDriver,
} from './inProcessRuntimeDriver.js';
export type {
    InProcessRuntimeDriverDeps,
    TimerScheduler,
    SyncRuntimeDriver,
} from './inProcessRuntimeDriver.js';

export { applyWakeToSnapshot, prepareSegmentWake } from './segmentWakeApplicator.js';
export type { PreparedSegmentWake } from './segmentWakeApplicator.js';

export { createInMemorySegmentDedupe } from './inMemorySegmentDedupe.js';
export type { SegmentDedupe } from './inMemorySegmentDedupe.js';

export {
    addProcessedSegmentKey,
    currentSegmentIdempotencyKey,
    currentTaskTurnClaim,
    nextSegmentOutboxIdempotencyKey,
    readProcessedSegmentKeys,
    runWithSegmentIdempotencyKey,
    segmentEffectIdempotencyKey,
    snapshotHasProcessedSegmentKey,
} from './segmentProcessedKeys.js';

export {
    isSegmentCancellationRequested,
    markSegmentCancellationRequested,
    readSegmentCancellation,
} from './segmentCancellation.js';
export type { SegmentCancellation } from './segmentCancellation.js';

export { TurnRunnerSegmentExecutor } from './turnRunnerSegmentExecutor.js';
export type {
    RuntimeContextBinding,
    TurnRunnerSegmentExecutorDeps,
} from './turnRunnerSegmentExecutor.js';

export { buildInProcessRuntimeStack } from './buildInProcessRuntimeStack.js';
export type {
    BuildInProcessRuntimeStackParams,
    InProcessRuntimeStack,
} from './buildInProcessRuntimeStack.js';

export {
    bootstrapCompositionRoot,
    bootstrapCompositionRootInternal,
} from './bootstrapCompositionRoot.js';
export type {
    BootstrapCompositionRootParams,
    RuntimeCompositionRoot,
    RuntimeCompositionRootInternal,
    TaskEngineOptions,
} from './bootstrapCompositionRoot.js';
