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
export { InteractiveTaskHandler } from './orchestration/InteractiveTaskResult.js';
export { Artifact } from './shared/types/index.js';
export type { TaskContext, AgentManifest, AgentTaskContext } from './shared/types/index.js';
export type { MentalState, EnvironmentState, ObservationInbox, MemoryReader, MemoryWriter } from './loop/types.js';
export type { ControlState, ControlPendingState } from './loop/types.js';
export { getPendingToken, controlSnapshot } from './loop/controlHelpers.js';
export type {
    ProposedAction,
    ExecutableAction,
    ExecResult,
    ExecErrorPayload,
    TransitionOut,
    TurnOutcome,
    ShieldOutcome,
    AttentionSignal,
    Observation,
    ObservationProvenance,
    ObservationConfig,
    SynthesizeObservation
} from './loop/oneTurn.js';
export type { Modules } from './loop/oneTurn.js';
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
export type { StageInvariants } from './loop/stageHelpers.js';
export { assertStageInvariants } from './loop/stageInvariants.js';
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
export type { LLMConfig, UniversalChatResponse, UniversalStreamResponse } from './shared/types/LLMTypes.js';
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
