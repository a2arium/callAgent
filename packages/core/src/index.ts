// Install global pg startup parameter guard FIRST, before any pool creation.
// This strips non-string params from pg's startup message to prevent ERR_INVALID_ARG_TYPE.
import './pgStartupDiagnostic.js';

export * from './config/index.js';
export * from './plugin/types.js';
export * from './plugin/createAgent.js';
export * from './runner/streamingRunner.js';
export {
    buildAgentIndex,
    type AgentIndexBuildResult,
    type AgentIndexEntry,
    DEFAULT_AGENT_INDEX_PATH
} from './plugin/AgentIndexBuilder.js';
export { loadAgentIndex, loadAgentIndexIfPresent, type LoadAgentIndexOptions } from './plugin/AgentIndexLoader.js';
export { AgentRegistry, globalAgentRegistry } from './plugin/AgentRegistry.js';
export { PluginManager } from './plugin/pluginManager.js';
export { ContextSerializer } from './orchestration/ContextSerializer.js';
export { A2AService, globalA2AService } from './orchestration/A2AService.js';
export { TaskEngine } from './orchestration/taskEngine.js';
export { EngineLocator } from './orchestration/EngineLocator.js';
export { InteractiveTaskHandler } from './orchestration/InteractiveTaskResult.js';
export { Artifact } from './shared/types/index.js';
export type { TaskContext, AgentCard, AgentRuntimeManifest, ResolvedManifests, AgentTaskContext } from './shared/types/index.js';
export type { MentalState, EnvironmentState, ObservationInbox, MemoryReader, MemoryWriter } from './loop/types.js';
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
} from './types/llmContracts.js';
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
export { eventBus } from './eventbus/inMemoryEventBus.js';
export { taskChannel } from './eventbus/taskEventEmitter.js';
export { outboxPublisher } from './eventbus/outboxPublisher.js';

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
export { OpikProvider } from './telemetry/providers/OpikProvider.js';
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
export { throwInvariantError } from './utils/invariantError.js';
export type { InvariantErrorCode, InvariantErrorContext, InvariantErrorDetail, InvariantErrorPayload } from './types/invariantError.js';
