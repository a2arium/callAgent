/**
 * Non-semver surface for examples, tests, and integrations that need direct access
 * to the conversation service and in-memory session wiring. Prefer `ctx.conversation`
 * in production agents.
 */
export { ConversationService } from './internal/conversation/ConversationService.js';
export { createDbMessageLog } from './eventbus/dbMessageLog.js';
export { InMemorySessionManager } from './orchestration/InMemorySessionManager.js';
export { SessionManager } from './orchestration/SessionManager.js';
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
    dispatchOutboxRow,
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
