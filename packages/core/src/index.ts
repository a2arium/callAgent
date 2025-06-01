export * from './core/plugin/createAgent.js';
export type { TaskContext } from './shared/types/index.js';
export type { LLMConfig, UniversalChatResponse, UniversalStreamResponse } from './shared/types/LLMTypes.js';
// Removed build utilities - use simple copying instead:
// "build": "tsc && copyfiles agent.json dist" or "tsc && cp agent.json dist/"
// Add other exports as needed for the public API 
export { createEmbeddingFunction, createEmbeddingFunctionWithTracking, isEmbeddingAvailable, getEmbeddingModel } from './core/llm/LLMFactory.js';

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