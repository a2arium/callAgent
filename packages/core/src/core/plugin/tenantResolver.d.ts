/**
 * Tenant resolution logic for CallAgent
 * Resolves tenant ID from multiple sources in priority order
 */
/**
 * Resolves tenant ID using the following hierarchy:
 * 1. Explicitly provided tenantId parameter
 * 2. CALLAGENT_TENANT_ID environment variable
 * 3. Default tenant 'default'
 *
 * @param explicitTenantId - Tenant ID explicitly provided by the caller
 * @returns Resolved tenant ID
 */
export declare function resolveTenantId(explicitTenantId?: string): string;
/**
 * Validates that a tenant ID is valid (non-empty string)
 * @param tenantId - Tenant ID to validate
 * @throws Error if tenant ID is invalid
 */
export declare function validateTenantId(tenantId: string): void;
