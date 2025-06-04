export * from './IMemory.js';
export * from './BaseError.js';
export * from './MemoryError.js';
export * from './workingMemory.js';
export * from './agent/AgentManifest.js';
export type {
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    MemoryRegistry,
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