export * from './config/index.js';
export * from './core/plugin/types.js';
export * from './core/plugin/createAgent.js';
export * from './runner/streamingRunner.js';
export {
    buildAgentIndex,
    type AgentIndexBuildResult,
    type AgentIndexEntry,
    DEFAULT_AGENT_INDEX_PATH
} from './core/plugin/AgentIndexBuilder.js';
export { loadAgentIndex, loadAgentIndexIfPresent, type LoadAgentIndexOptions } from './core/plugin/AgentIndexLoader.js';
export { AgentRegistry, globalAgentRegistry } from './core/plugin/AgentRegistry.js';
export { PluginManager } from './core/plugin/pluginManager.js';
export { ContextSerializer } from './core/orchestration/ContextSerializer.js';
export { A2AService, globalA2AService } from './core/orchestration/A2AService.js';
export { TaskEngine } from './core/orchestration/taskEngine.js';
export { InteractiveTaskHandler } from './core/orchestration/InteractiveTaskResult.js';
export type { TaskContext, AgentManifest, AgentTaskContext } from './shared/types/index.js';
export type { MentalState, EnvironmentState, ObservationInbox } from './loop/types.js';
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
} from './shared/types/observation.js';
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
export { createEmbeddingFunction, createEmbeddingFunctionWithTracking, isEmbeddingAvailable, getEmbeddingModel } from './core/llm/LLMFactory.js';

// Memory system exports
export { createMemoryRegistry } from './core/memory/createMemoryRegistry.js';
export type { ExtendedIMemory } from './core/memory/createMemoryRegistry.js';

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
} from './core/plugin/tenantValidator.js';

// Tenant context management
export {
    TenantContextManager,
    tenantContextManager,
    withTenant,
    withSystemPrivileges,
    getCurrentTenant
} from './core/plugin/TenantContext.js';

// Tenant metrics and monitoring
export {
    TenantMetricsManager,
    tenantMetricsManager,
    trackTenantOperation,
    type TenantMetrics
} from './core/plugin/TenantMetrics.js';
// Event bus and task channel helpers
export { eventBus } from './eventbus/inMemoryEventBus.js';
export { taskChannel } from './eventbus/taskEventEmitter.js';