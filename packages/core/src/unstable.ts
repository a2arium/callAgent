/**
 * Non-semver surface for examples, tests, and integrations that need direct access
 * to the conversation service and in-memory session wiring. Prefer `ctx.conversation`
 * in production agents.
 */
export { ConversationService } from './internal/conversation/ConversationService.js';
export { createDbMessageLog } from './eventbus/dbMessageLog.js';
export { InMemorySessionManager } from './orchestration/InMemorySessionManager.js';
export { SessionManager } from './orchestration/SessionManager.js';
export {
    claimTaskTerminalInSnapshot,
    readDurableTaskTerminal,
    type DurableTaskTerminal,
} from './orchestration/TaskLifecycle.js';
export type { IEventBus, BusEventHandler } from './public-types/eventbus/types.js';
export {
    bootstrapCompositionRootInternal,
    type RuntimeCompositionRootInternal,
} from './runtime/bootstrapCompositionRoot.js';
export * from './runtime/index.js';
export {
    budgetEnvelope,
    budgetErrorPayload,
    compactOperationalEventPayload,
    compactPayload,
    enforcePayloadBudget,
    isPayloadEnvelope,
    measureJsonBytes,
    operatorPayloadEnvelope,
    readDriverMetadataMaxBytes,
    readEventPayloadMaxBytes,
    readHatchetPayloadMaxBytes,
    readOperatorRawPayloadMaxBytes,
    type PayloadBudgetCode,
    type PayloadBudgetResult,
    type PayloadEnvelope,
} from './operator/payloadBudget.js';
export {
    MetricsRegistry,
    defaultMetricsRegistry,
    type MetricDimensions,
    type MetricsRegistryOptions,
    type MetricsSnapshot,
} from './observability/metrics.js';
export { makeSafeEventPreview } from './orchestration/safeEventPreview.js';
export {
    assertTaskEffectActive,
    registerTaskEffect,
    type TaskEffectKind,
    type TaskEffectRegistrationResult,
} from './orchestration/TaskEffectRegistration.js';
export { prepareChildResultForPersistence } from './orchestration/childResultPersistence.js';
export {
    assertCurrentTaskTurn,
    markTaskTurnDispatchEnqueued,
    readTaskTurnCoordinator,
    releaseTaskTurn,
    renewTaskTurnClaim,
    requestTaskTurn,
    type RequestTaskTurnResult,
    type TaskTurnClaim,
    type TaskTurnCoordinatorState,
} from './orchestration/TaskTurnCoordinator.js';
export {
    reconcileSnapshotMutation,
    SnapshotReconciliationError,
    isSnapshotReconciliationError,
    type ReconcileSnapshotMutationOptions,
    type SnapshotMutationCurrent,
    type SnapshotMutationDecision,
    type SnapshotMutationResult,
    type SnapshotMutationSession,
} from './orchestration/persistence/SnapshotRepository.js';
export {
    claimChildTerminalInSnapshot,
    coordinateChildTerminal,
    childTerminalEventPayload,
    getChildTerminal,
    type ChildTerminalClaim,
    type ChildTerminalError,
    type ChildTerminalRequest,
    type ChildTerminalSession,
} from './orchestration/ChildTerminalCoordinator.js';
export {
    dispatchOutboxRow,
    claimOutboxRow,
    deleteClaimedOutboxRow,
    releaseClaimedOutboxRow,
    readOutboxStorageNow,
    deleteOutboxRow,
    handleOutboxDispatchFailure,
    outboxChannel,
    getOutboxDispatcherMode,
    getHatchetOutboxTopics,
    isHatchetOutboxTopic,
    shouldPollerSkipOutboxRow,
    parseTraceIdFromTraceparent,
    resolveOutboxDispatchContext,
    HATCHET_OUTBOX_DISPATCH_RETRIES,
    type OutboxRow,
    type OutboxDispatchContext,
} from './eventbus/outboxDispatch.js';
