import { logger } from '@callagent/utils';

// Create component-specific logger
const validatorLogger = logger.createLogger({ prefix: 'TenantValidator' });

/**
 * Special tenant IDs with specific behaviors
 */
export const SYSTEM_TENANT = '__system__';
export const DEFAULT_TENANT = 'default';

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
 * Default validation configuration
 */
const DEFAULT_CONFIG: TenantValidationConfig = {
    maxTenantIdLength: 64,
    allowedCharacters: /^[a-zA-Z0-9_-]+$/,
    reservedTenantIds: [SYSTEM_TENANT],
    requirePermissionChecks: false // Set to true in production for stricter security
};

/**
 * Current validation configuration
 */
let validationConfig: TenantValidationConfig = { ...DEFAULT_CONFIG };

/**
 * Permission registry for tenant access control
 * In production, this would be backed by a proper authorization system
 */
const tenantPermissions = new Map<string, Set<string>>();

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
export function validateTenantId(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string') {
        throw new Error('Tenant ID must be a non-empty string');
    }

    // Trim whitespace for validation
    const trimmedTenantId = tenantId.trim();

    if (trimmedTenantId === '') {
        throw new Error('Tenant ID must be a non-empty string');
    }

    if (trimmedTenantId !== tenantId) {
        throw new Error('Tenant ID cannot contain leading or trailing whitespace');
    }

    if (tenantId.length > validationConfig.maxTenantIdLength) {
        throw new Error(`Tenant ID cannot exceed ${validationConfig.maxTenantIdLength} characters`);
    }

    if (!validationConfig.allowedCharacters.test(tenantId)) {
        throw new Error('Tenant ID can only contain letters, numbers, hyphens, and underscores');
    }

    // Check for reserved tenant IDs (except system tenant which has special handling)
    if (validationConfig.reservedTenantIds.includes(tenantId) && tenantId !== SYSTEM_TENANT) {
        throw new Error(`Tenant ID '${tenantId}' is reserved and cannot be used`);
    }

    validatorLogger.debug('Tenant ID validated successfully', { tenantId });
}

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
export function checkTenantPermissions(agentId: string, tenantId: string): boolean {
    // Validate inputs
    if (!agentId || !tenantId) {
        validatorLogger.warn('Invalid agent ID or tenant ID for permission check', {
            agentId: agentId || 'undefined',
            tenantId: tenantId || 'undefined'
        });
        return false;
    }

    // System tenant requires special permission
    if (tenantId === SYSTEM_TENANT) {
        const hasSystemAccess = hasSystemPermission(agentId);
        validatorLogger.debug('System tenant access check', {
            agentId,
            hasAccess: hasSystemAccess
        });
        return hasSystemAccess;
    }

    // If permission checks are disabled, allow access (development mode)
    if (!validationConfig.requirePermissionChecks) {
        validatorLogger.debug('Permission checks disabled, allowing access', {
            agentId,
            tenantId
        });
        return true;
    }

    // Check explicit permissions
    const agentPermissions = tenantPermissions.get(agentId);
    const hasPermission = agentPermissions?.has(tenantId) || agentPermissions?.has('*') || false;

    validatorLogger.debug('Tenant permission check', {
        agentId,
        tenantId,
        hasPermission,
        explicitPermissions: Array.from(agentPermissions || [])
    });

    return hasPermission;
}

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
export function grantTenantPermission(agentId: string, tenantId: string): void {
    validateTenantId(agentId); // Validate agent ID using same rules

    if (tenantId !== '*') {
        validateTenantId(tenantId);
    }

    if (!tenantPermissions.has(agentId)) {
        tenantPermissions.set(agentId, new Set());
    }

    tenantPermissions.get(agentId)!.add(tenantId);

    validatorLogger.info('Tenant permission granted', {
        agentId,
        tenantId
    });
}

/**
 * Revoke an agent's permission to access a specific tenant
 * 
 * @param agentId - The ID of the agent to revoke permission from
 * @param tenantId - The tenant ID to revoke access to
 */
export function revokeTenantPermission(agentId: string, tenantId: string): void {
    const agentPermissions = tenantPermissions.get(agentId);
    if (agentPermissions) {
        agentPermissions.delete(tenantId);

        if (agentPermissions.size === 0) {
            tenantPermissions.delete(agentId);
        }

        validatorLogger.info('Tenant permission revoked', {
            agentId,
            tenantId
        });
    }
}

/**
 * Check if an agent has system-level permissions
 * 
 * @param agentId - The ID of the agent to check
 * @returns True if the agent has system permissions
 */
export function hasSystemPermission(agentId: string): boolean {
    const agentPermissions = tenantPermissions.get(agentId);
    return agentPermissions?.has(SYSTEM_TENANT) || false;
}

/**
 * Grant system-level permissions to an agent
 * 
 * WARNING: System permissions allow cross-tenant access and should only
 * be granted to trusted administrative agents.
 * 
 * @param agentId - The ID of the agent to grant system permissions to
 */
export function grantSystemPermission(agentId: string): void {
    grantTenantPermission(agentId, SYSTEM_TENANT);

    validatorLogger.warn('System permissions granted', {
        agentId,
        timestamp: new Date().toISOString()
    });
}

/**
 * Revoke system-level permissions from an agent
 * 
 * @param agentId - The ID of the agent to revoke system permissions from
 */
export function revokeSystemPermission(agentId: string): void {
    revokeTenantPermission(agentId, SYSTEM_TENANT);

    validatorLogger.info('System permissions revoked', {
        agentId,
        timestamp: new Date().toISOString()
    });
}

/**
 * Get all tenants an agent has permission to access
 * 
 * @param agentId - The ID of the agent
 * @returns Array of tenant IDs the agent can access
 */
export function getAgentTenantPermissions(agentId: string): string[] {
    const permissions = tenantPermissions.get(agentId);
    return permissions ? Array.from(permissions) : [];
}

/**
 * Check if a tenant ID represents a system tenant
 * 
 * @param tenantId - The tenant ID to check
 * @returns True if it's a system tenant
 */
export function isSystemTenant(tenantId: string): boolean {
    return tenantId === SYSTEM_TENANT;
}

/**
 * Check if a tenant ID is the default tenant
 * 
 * @param tenantId - The tenant ID to check
 * @returns True if it's the default tenant
 */
export function isDefaultTenant(tenantId: string): boolean {
    return tenantId === DEFAULT_TENANT;
}

/**
 * Update tenant validation configuration
 * 
 * @param config - Partial configuration to update
 */
export function updateValidationConfig(config: Partial<TenantValidationConfig>): void {
    validationConfig = { ...validationConfig, ...config };

    validatorLogger.info('Tenant validation configuration updated', {
        config: validationConfig
    });
}

/**
 * Get current validation configuration
 * 
 * @returns Current validation configuration
 */
export function getValidationConfig(): TenantValidationConfig {
    return { ...validationConfig };
}

/**
 * Reset all tenant permissions (useful for testing)
 * 
 * WARNING: This will revoke all permissions. Use with caution.
 */
export function resetPermissions(): void {
    tenantPermissions.clear();
    validatorLogger.warn('All tenant permissions have been reset');
}

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
export function sanitizeTenantId(input: string): string | null {
    if (!input || typeof input !== 'string') {
        return null;
    }

    // Trim whitespace and convert to lowercase
    let sanitized = input.trim().toLowerCase();

    // Replace invalid characters with hyphens
    sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '-');

    // Remove consecutive hyphens
    sanitized = sanitized.replace(/-+/g, '-');

    // Remove leading/trailing hyphens
    sanitized = sanitized.replace(/^-+|-+$/g, '');

    // Check if result is valid
    if (sanitized.length === 0 || sanitized.length > validationConfig.maxTenantIdLength) {
        return null;
    }

    try {
        validateTenantId(sanitized);
        return sanitized;
    } catch {
        return null;
    }
} 