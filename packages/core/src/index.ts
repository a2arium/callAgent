// Install global pg startup parameter guard FIRST, before any pool creation.
// This strips non-string params from pg's startup message to prevent ERR_INVALID_ARG_TYPE.
import './pgStartupDiagnostic.js';

export * from './config/index.js';
export * from './plugin/types.js';
export * from './plugin/createAgent.js';
export {
    createApiRouter,
    createRuntimeApiRouter,
    createOperatorApiRouter,
    type CreateApiRouterOptions,
} from './api/router.js';
export {
    buildAgentRunGraph,
    type AgentRunGraph,
    type AgentRunNode,
    type AgentRunEdge,
    type TurnRun,
    type EffectRun,
} from './operator/runGraph.js';
export {
    buildAgentIndex,
    type AgentIndexBuildResult,
    type AgentIndexEntry,
    DEFAULT_AGENT_INDEX_PATH
} from './plugin/AgentIndexBuilder.js';
export { loadAgentIndex, loadAgentIndexIfPresent, type LoadAgentIndexOptions } from './plugin/AgentIndexLoader.js';
export {
    DEFAULT_WORKSPACE_ENV_FILE,
    DEFAULT_WORKSPACE_REGISTRY_PATH,
    WorkspaceResolutionError,
    resolveWorkspaceEnvironment,
    resolveWorkspaceRuntime,
    workspaceDescriptorFingerprint,
    type ResolveWorkspaceOptions,
    type ResolvedAgentSource,
    type ResolvedWorkspaceAgent,
    type ResolvedWorkspaceEnvironment,
    type RuntimeWorkspaceDescriptor,
    type WorkspaceEnvironmentConflict,
    type WorkspaceEnvironmentMetadata,
    type WorkspaceResolutionIssue,
} from './plugin/WorkspaceResolution.js';
export {
    getAgentWorkspaceInfo,
    registerAgentWorkspaceInfo,
    loadWorkspaces,
    type AgentWorkspaceInfo,
    type LoadWorkspacesOptions,
    type WorkspaceDefinition,
    type WorkspaceEnvConflict,
    type WorkspaceLoadResult,
    type WorkspaceLoadSummary,
} from './plugin/WorkspaceLoader.js';
export { AgentRegistry, globalAgentRegistry } from './plugin/AgentRegistry.js';
export { PluginManager } from './plugin/pluginManager.js';
export { ContextSerializer } from './orchestration/ContextSerializer.js';
export { A2AService, globalA2AService } from './orchestration/A2AService.js';
export {
    TaskEngine,
    BackgroundTaskDrainError,
    TaskSubmissionError,
    type SubmitTaskParams,
    type SubmitTaskResult,
    type TaskSubmissionErrorCode,
    type TaskSubmissionOrigin,
} from './orchestration/taskEngine.js';
export { EngineLocator } from './orchestration/EngineLocator.js';
export {
    bootstrapCompositionRoot,
    type BootstrapCompositionRootParams,
    type RuntimeCompositionRoot,
    type TaskEngineOptions,
} from './runtime/bootstrapCompositionRoot.js';
export { InteractiveTaskHandler } from './orchestration/InteractiveTaskResult.js';
export { Artifact } from './shared/types/index.js';
export type {
    A2AEvent,
    TaskContext,
    AgentCard,
    AgentRuntimeManifest,
    ResolvedManifests,
    AgentTaskContext
} from './shared/types/index.js';
export type {
    MentalState,
    EnvironmentState,
    ObservationInbox,
    MemoryReader,
    MemoryWriter,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
} from './loop/types.js';
export type { ControlState, ControlPendingState } from './loop/types.js';
export { getPendingToken, controlSnapshot } from './loop/controlHelpers.js';
export type {
    ExecResult,
    ExecErrorPayload,
    TransitionOut,
    TurnOutcome,
    ShieldOutcome,
    AttentionSignal,
    Observation,
    ObservationProvenance
} from './loop/oneTurn.js';
export type { Modules } from './loop/oneTurn.js';
export type { ExecOutcome } from './types/execOutcome.js';
export { ExecOutcomeSchema, ExecResultSchema } from './types/execOutcome.js';
export { IntentSchema, ExecutableActionSchema } from './types/intent.js';
export type { Intent, ExecutableAction } from './types/intent.js';
export type {
    LLMCallOptions,
    LLMSettings,
    LLMOutputContract,
} from './types/llmContracts.js';
export {
    LLMCallOptionsSchema,
    LLMSettingsSchema,
    LLMOutputContractSchema,
    MAX_LLM_TIMEOUT_MS,
} from './types/llmContracts.js';
export {
    LLMTimeoutError,
    LLMCancelledError,
    isLLMTimeoutError,
    isLLMCancelledError,
} from './types/llmErrors.js';
export type { LLMTerminalErrorCode } from './types/llmErrors.js';
export type {
    ChildCompletedPayload,
    ChildCompletedObservation,
    InteractiveTaskSnapshot,
    TaskStatusWithResult,
    TaskStatusMetadataWithResult
} from './shared/types/index.js';
export {
    isChildCompletedObservation,
    extractChildResult,
    findChildCompletion
} from './helpers/childObservations.js';
export { runEffect } from './loop/effects.js';
export { createStageFacade } from './loop/stageHelpers.js';
export { assertStageInvariants } from './loop/stageInvariants.js';
export { defineControlKeys } from './types/stageFacade.js';
export type {
    StageFacade,
    StageEnterContext,
    StageInvariantRule,
    StageInvariantMap,
    StageTransitionResult,
    StageInvariantCheckResult,
    StageTraceEntry,
    StageSummary,
    ControlKeyMap,
    CreateStageFacadeOptions,
} from './types/stageFacade.js';
export { readControlVar, writeControlVar, deleteControlVar, resolveControlVars } from './loop/controlVarAccessors.js';
export type {
    ChildCompletionInput,
    ToolCompletionInput,
    DirectInput,
    ExternalEventInput,
    InputKind
} from './shared/types/index.js';
export {
    isChildCompletionInput,
    isToolCompletionInput,
    isDirectInput,
    isExternalEventInput
} from './shared/types/index.js';
export { ensureAgentContext } from './shared/types/index.js';
export type { LLMConfig, UniversalChatResponse, UniversalStreamResponse, ToolDefinition, LLMMessage } from './shared/types/LLMTypes.js';
export {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    RuntimeStreamEnvelopeBaseSchema,
    RuntimeStreamMessagePartSchema,
    RuntimeStreamTaskStateSchema,
    StreamChannelSchema,
    StreamVisibilitySchema,
    isTerminalRuntimeStreamStatus,
} from './streaming/runtimeStreamEvents.js';
export type {
    RuntimeStreamEvent,
    RuntimeStreamMessagePart,
    RuntimeStreamTaskState,
    RuntimeStreamVisibility,
    RuntimeStreamChannel,
    RuntimeStreamTaskStatusEvent,
} from './streaming/runtimeStreamEvents.js';
export {
    projectRuntimeStreamPublic,
    projectRuntimeStreamDebug,
    projectRuntimeStreamSse,
    projectRuntimeStreamChat,
} from './streaming/projections.js';
export {
    mapA2AEventToRuntimeStream,
} from './streaming/a2aMapper.js';
export type {
    A2AToRuntimeStreamOptions,
} from './streaming/a2aMapper.js';
export {
    WorkingMemoryRuntimeStreamEventSchema,
    mapWorkingMemoryEventToRuntimeStream,
} from './streaming/sessionEventMapper.js';
export {
    bindRuntimeCognitionStream,
} from './streaming/cognitionRuntimePublisher.js';
export type {
    WorkingMemoryRuntimeStreamEvent,
    WorkingMemoryToRuntimeStreamOptions,
} from './streaming/sessionEventMapper.js';
export type {
    RuntimeStreamSseProjectionEvent,
    RuntimeStreamChatProjectionEvent,
} from './streaming/projections.js';
export type {
    LLMRespondedPayload,
    ValidationFailedPayload,
} from './types/observation.js';
export {
    LLMRespondedPayloadSchema,
    ValidationFailedPayloadSchema,
} from './types/observation.js';
// Removed build utilities - use simple copying instead:
// "build": "tsc && copyfiles agent.json dist" or "tsc && cp agent.json dist/"
// Add other exports as needed for the public API 
export { createEmbeddingFunction, createEmbeddingFunctionWithTracking, isEmbeddingAvailable, getEmbeddingModel } from './llm/LLMFactory.js';

// Memory system exports
export { createMemoryRegistry } from '@a2arium/callagent-memory-engine';
export type { ExtendedIMemory } from '@a2arium/callagent-memory-engine';
export { SemanticQueryError } from '@a2arium/callagent-types';
export type {
    SemanticQueryErrorCode,
    SemanticQueryErrorDetails,
    SemanticMemoryCapabilities,
    SemanticTagQueryCapability,
    SemanticPredicateRemovalCapability,
    SemanticRemoveResult,
    SemanticQueryTelemetry,
} from '@a2arium/callagent-types';

// Tenant management exports
export {
    SYSTEM_TENANT,
    DEFAULT_TENANT,
    validateTenantId,
    checkTenantPermissions,
    grantTenantPermission,
    revokeTenantPermission,
    hasSystemPermission,
    grantSystemPermission,
    revokeSystemPermission,
    getAgentTenantPermissions,
    isSystemTenant,
    isDefaultTenant,
    sanitizeTenantId,
    type TenantValidationConfig
} from './plugin/tenantValidator.js';

// Tenant context management
export {
    TenantContextManager,
    tenantContextManager,
    withTenant,
    withSystemPrivileges,
    getCurrentTenant
} from './plugin/TenantContext.js';

// Tenant metrics and monitoring
export {
    TenantMetricsManager,
    tenantMetricsManager,
    trackTenantOperation,
    type TenantMetrics
} from './plugin/TenantMetrics.js';
// Event bus and task channel helpers
export { createInMemoryEventBus, InMemoryEventBus } from './eventbus/inMemoryEventBus.js';
export type { IEventBus, BusEventHandler } from './public-types/eventbus/types.js';
export { BusEventSchema, CloudEventSchema } from './public-types/eventbus/schemas.js';
export type { BusEvent, CloudEvent } from './public-types/eventbus/schemas.js';
export { createBusEvent, busEventData } from './eventbus/busEventHelpers.js';
export { taskChannel } from './eventbus/taskEventEmitter.js';
export { OutboxPublisher } from './eventbus/outboxPublisher.js';
export {
    createInProcessDurableSubscription,
    createNatsJetStreamDurableSubscription,
    type DurableSubscriptionPersistence,
} from './eventbus/inProcessDurableSubscription.js';
export {
    resolveTransportAdapters,
    TransportAdapterConfigSchema,
    EventBusAdapterConfigSchema,
    MessageLogAdapterConfigSchema,
    type TransportAdapterConfig,
    type ResolvedTransportAdapters,
} from './orchestration/AdapterFactory.js';
export {
    AdapterErrorThrowable,
    AdapterErrorSchema,
    isAdapterErrorThrowable,
    type AdapterError,
} from './public-types/eventbus/error.js';
export {
    BackpressureManager,
    DEFAULT_BACKPRESSURE_THRESHOLDS,
    type BackpressureConsumerState,
    type BackpressureThresholds,
    type TopicPostBackpressureSample,
} from './internal/conversation/BackpressureManager.js';

// TurnTrace
export type {
    TurnTrace,
    TurnTimings,
    TurnUsage,
    PendingSummary,
    ShieldTrace,
    ManifestProvenance,
    ManifestSource,
    JsonValue,
} from './types/turnTrace.js';

// TurnTrace collection
export { TurnTraceCollector } from './telemetry/TurnTraceCollector.js';

// Manifest provenance
export {
    resolveManifestProvenance,
    computeStableHash,
    validateManifestIdentity,
} from './telemetry/manifestProvenance.js';

// Telemetry
export type { TelemetryProvider } from './telemetry/Provider.js';
export { telemetry, TelemetryCollector } from './telemetry/TelemetryCollector.js';
export { ConsoleProvider } from './telemetry/providers/ConsoleProvider.js';
export { CallagentBridgeProvider } from './telemetry/providers/CallagentBridgeProvider.js';

// Telemetry nodes (no ModuleNode)
export { TelemetryNode } from './telemetry/nodes/TelemetryNode.js';
export { AgentNode } from './telemetry/nodes/AgentNode.js';
export { TurnNode } from './telemetry/nodes/TurnNode.js';
export { ChildCallNode } from './telemetry/nodes/ChildCallNode.js';
export { LLMNode } from './telemetry/nodes/LLMNode.js';
export { ToolNode } from './telemetry/nodes/ToolNode.js';
// Error system exports
export { FrameworkError, PluginError, ManifestError, TaskExecutionError, AgentError, ConfigurationError, InvariantError, ModuleExecutionError, FrameworkModule, isErrorType } from './utils/errors.js';
export {
    SnapshotReconciliationError,
    isSnapshotReconciliationError,
} from './orchestration/persistence/SnapshotRepository.js';
export { throwInvariantError } from './utils/invariantError.js';
export type { InvariantErrorCode, InvariantErrorContext, InvariantErrorDetail, InvariantErrorPayload } from './types/invariantError.js';

// Testing Harness exports
export { createTestHarness, type TestHarness } from './testing/TestHarness.js';
export { createDeterministicLLMStub, createDeterministicToolStub, type DeterministicLLMStub, type DeterministicToolStub } from './testing/DeterministicStubs.js';
export { createTestContext, type CreateTestContextOptions } from './testing/TestContext.js';
export { HarnessAssertionError, createTurnAssertionContext } from './testing/HarnessAssertions.js';
export {
    HarnessConfigSchema,
    type HarnessConfig,
    type HarnessState,
    type LLMStubResponse,
    type TurnAssertionContext,
    type DeepPartial,
    type HarnessCommunicationManifestPatch,
} from './testing/harnessTypes.js';
export * from './public-types/conversation/index.js';
export * from './public-types/messageLog/index.js';
export {
    topicTranscriptProjectionToken,
    ensureBuiltinTopicProjectionsRegistered,
} from './internal/conversation/builtinTopicProjections.js';
export {
    getTopicProjectionRegistry,
    type TopicProjectionRegistry,
} from './internal/conversation/TopicProjectionRegistry.js';

// Agent scaffolding
export { scaffoldAgent, formatScaffoldError } from './scaffold/scaffoldAgent.js';
export {
    ScaffoldOptionsSchema,
    type AgentPreset,
    type ScaffoldOptions,
    type ScaffoldResult,
    type ScaffoldFailure,
} from './scaffold/types.js';
export * from './operator/agentSchedules.js';
export type { OperatorRequestContext } from './operator/operatorAuth.js';
