export * from './IMemory.js';
export * from './BaseError.js';
export * from './MemoryError.js';
export type {
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    MemoryRegistry,
} from './IMemory.js';

// Tenant-related types for multi-tenant support
export type TenantContext = {
    tenantId: string;
    isSystemTenant?: boolean;
};

export type AgentConfig = {
    tenantId?: string;
    // Future: Additional agent configuration options
}; 