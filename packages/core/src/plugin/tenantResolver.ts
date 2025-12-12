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
export function resolveTenantId(explicitTenantId?: string): string {
    return (
        explicitTenantId ||
        process.env.CALLAGENT_TENANT_ID ||
        'default'
    );
}

/**
 * Validates that a tenant ID is valid (non-empty string)
 * @param tenantId - Tenant ID to validate
 * @throws Error if tenant ID is invalid
 */
export function validateTenantId(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
        throw new Error('Tenant ID must be a non-empty string');
    }
} 