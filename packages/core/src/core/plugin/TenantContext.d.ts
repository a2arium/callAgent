/**
 * Tenant Context Manager
 *
 * Provides dynamic tenant switching capabilities using AsyncLocalStorage.
 * This allows operations to temporarily switch tenant context while preserving
 * the original context for nested operations.
 */
export declare class TenantContextManager {
    /**
     * Execute an operation with a specific tenant context
     *
     * @param tenantId - The tenant ID to switch to
     * @param operation - The operation to execute in the tenant context
     * @returns Promise that resolves to the operation result
     *
     * @example
     * ```typescript
     * const result = await tenantManager.withTenant('customer-123', async () => {
     *   // All operations here are scoped to customer-123
     *   await ctx.memory.semantic.set('key', 'value');
     *   return await ctx.memory.semantic.get('key');
     * });
     * ```
     */
    withTenant<T>(tenantId: string, operation: () => Promise<T>): Promise<T>;
    /**
     * Get the current tenant ID from the async context
     *
     * @returns The current tenant ID, or null if no context is set
     */
    getCurrentTenant(): string | null;
    /**
     * Get the original tenant ID (before any switches)
     *
     * @returns The original tenant ID, or current tenant if no switches occurred
     */
    getOriginalTenant(): string | null;
    /**
     * Get the current tenant context depth
     *
     * @returns The nesting depth of tenant switches (0 = no context)
     */
    getContextDepth(): number;
    /**
     * Check if currently in a switched tenant context
     *
     * @returns True if in a switched context
     */
    isInSwitchedContext(): boolean;
    /**
     * Get the complete current context (internal method)
     *
     * @returns The current tenant context or null
     */
    private getCurrentContext;
    /**
     * Execute an operation with elevated system privileges
     *
     * WARNING: This should only be used for administrative operations
     * that need to access data across tenants.
     *
     * @param operation - The operation to execute with system privileges
     * @returns Promise that resolves to the operation result
     */
    withSystemPrivileges<T>(operation: () => Promise<T>): Promise<T>;
    /**
     * Execute an operation ensuring it runs in the original tenant context
     * (useful for cleanup operations that should revert to original context)
     *
     * @param operation - The operation to execute in original context
     * @returns Promise that resolves to the operation result
     */
    withOriginalTenant<T>(operation: () => Promise<T>): Promise<T>;
}
/**
 * Global tenant context manager instance
 */
export declare const tenantContextManager: TenantContextManager;
/**
 * Convenience function for tenant switching
 *
 * @param tenantId - The tenant ID to switch to
 * @param operation - The operation to execute
 * @returns Promise that resolves to the operation result
 */
export declare const withTenant: <T>(tenantId: string, operation: () => Promise<T>) => Promise<T>;
/**
 * Convenience function for system operations
 *
 * @param operation - The operation to execute with system privileges
 * @returns Promise that resolves to the operation result
 */
export declare const withSystemPrivileges: <T>(operation: () => Promise<T>) => Promise<T>;
/**
 * Get current tenant from async context
 *
 * @returns Current tenant ID or null
 */
export declare const getCurrentTenant: () => string | null;
