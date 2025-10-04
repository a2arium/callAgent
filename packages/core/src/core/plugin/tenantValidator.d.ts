/**
 * Special tenant IDs with specific behaviors
 */
export declare const SYSTEM_TENANT = "__system__";
export declare const DEFAULT_TENANT = "default";
/**
 * Configuration for tenant validation
 */
export type TenantValidationConfig = {
    maxTenantIdLength: number;
    allowedCharacters: RegExp;
    reservedTenantIds: string[];
    requirePermissionChecks: boolean;
};
/**
 * Validate a tenant ID format and security constraints
 *
 * @param tenantId - The tenant ID to validate
 * @throws {Error} If the tenant ID is invalid
 *
 * @example
 * ```typescript
 * validateTenantId('customer-123'); // ✓ Valid
 * validateTenantId(''); // ✗ Throws error
 * validateTenantId('invalid@tenant'); // ✗ Throws error
 * ```
 */
export declare function validateTenantId(tenantId: string): void;
/**
 * Check if an agent has permission to access a specific tenant
 *
 * @param agentId - The ID of the agent requesting access
 * @param tenantId - The tenant ID to access
 * @returns True if access is allowed
 *
 * @example
 * ```typescript
 * // Grant permission first
 * grantTenantPermission('agent-123', 'customer-456');
 *
 * // Check permission
 * const hasAccess = checkTenantPermissions('agent-123', 'customer-456'); // true
 * ```
 */
export declare function checkTenantPermissions(agentId: string, tenantId: string): boolean;
/**
 * Grant an agent permission to access a specific tenant
 *
 * @param agentId - The ID of the agent to grant permission to
 * @param tenantId - The tenant ID to grant access to (or '*' for all tenants)
 *
 * @example
 * ```typescript
 * grantTenantPermission('agent-123', 'customer-456');
 * grantTenantPermission('admin-agent', '*'); // Grant access to all tenants
 * ```
 */
export declare function grantTenantPermission(agentId: string, tenantId: string): void;
/**
 * Revoke an agent's permission to access a specific tenant
 *
 * @param agentId - The ID of the agent to revoke permission from
 * @param tenantId - The tenant ID to revoke access to
 */
export declare function revokeTenantPermission(agentId: string, tenantId: string): void;
/**
 * Check if an agent has system-level permissions
 *
 * @param agentId - The ID of the agent to check
 * @returns True if the agent has system permissions
 */
export declare function hasSystemPermission(agentId: string): boolean;
/**
 * Grant system-level permissions to an agent
 *
 * WARNING: System permissions allow cross-tenant access and should only
 * be granted to trusted administrative agents.
 *
 * @param agentId - The ID of the agent to grant system permissions to
 */
export declare function grantSystemPermission(agentId: string): void;
/**
 * Revoke system-level permissions from an agent
 *
 * @param agentId - The ID of the agent to revoke system permissions from
 */
export declare function revokeSystemPermission(agentId: string): void;
/**
 * Get all tenants an agent has permission to access
 *
 * @param agentId - The ID of the agent
 * @returns Array of tenant IDs the agent can access
 */
export declare function getAgentTenantPermissions(agentId: string): string[];
/**
 * Check if a tenant ID represents a system tenant
 *
 * @param tenantId - The tenant ID to check
 * @returns True if it's a system tenant
 */
export declare function isSystemTenant(tenantId: string): boolean;
/**
 * Check if a tenant ID is the default tenant
 *
 * @param tenantId - The tenant ID to check
 * @returns True if it's the default tenant
 */
export declare function isDefaultTenant(tenantId: string): boolean;
/**
 * Update tenant validation configuration
 *
 * @param config - Partial configuration to update
 */
export declare function updateValidationConfig(config: Partial<TenantValidationConfig>): void;
/**
 * Get current validation configuration
 *
 * @returns Current validation configuration
 */
export declare function getValidationConfig(): TenantValidationConfig;
/**
 * Reset all tenant permissions (useful for testing)
 *
 * WARNING: This will revoke all permissions. Use with caution.
 */
export declare function resetPermissions(): void;
/**
 * Sanitize a tenant ID by removing invalid characters and formatting
 *
 * @param input - The input string to sanitize
 * @returns Sanitized tenant ID or null if it cannot be made valid
 *
 * @example
 * ```typescript
 * sanitizeTenantId('Customer@123!'); // Returns 'customer-123'
 * sanitizeTenantId('   valid-tenant   '); // Returns 'valid-tenant'
 * ```
 */
export declare function sanitizeTenantId(input: string): string | null;
