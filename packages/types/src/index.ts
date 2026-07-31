export * from './conversationPersistence.js';
export * from './IMemory.js';
export * from './BaseError.js';
export * from './MemoryError.js';
export * from './SemanticAtomicError.js';
export * from './SemanticQueryError.js';
export * from './working-memory-version-conflict.js';
export * from './task-lifecycle-terminal.js';
export * from './task-turn-superseded.js';
export * from './task-turn-coordinator-state.js';
export * from './workingMemory.js';
export * from './agent/agentCard.js';
export * from './agent/agentRuntimeManifest.js';
export * from './agent/manifestSource.js';
export * from './agent/manifestErrors.js';
export type {
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    MemoryRegistry,
    SemanticAddInput,
    SemanticItem,
    SemanticReadFilter,
    SemanticReadPageFilter,
    SemanticReadPage,
    SemanticRemoveFilter,
    SemanticRemoveResult,
    SemanticPredicateFilter,
    SemanticVersionedValue,
    SemanticCompareAndSetInput,
    SemanticCompareAndSetResult,
    SemanticCompareAndSetOptions,
    SemanticAtomicCapability,
    SemanticMemoryCapabilities,
    SemanticTagQueryCapability,
    SemanticPredicateRemovalCapability,
    SemanticPaginationCapability,
    SemanticQueryTelemetry,
} from './IMemory.js';

export type {
    WorkingMemoryBackend,
    WorkingMemoryState,
    ThoughtEntry,
    DecisionEntry,
    WorkingVariables,
    SerializedWorkingMemoryState,
} from './workingMemory.js';

// Tenant-related types for multi-tenant support
export type TenantContext = {
    tenantId: string;
    isSystemTenant?: boolean;
};

export type AgentConfig = {
    tenantId?: string;
    // Future: Additional agent configuration options
};
