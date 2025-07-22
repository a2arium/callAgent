import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@a2arium/callagent-utils';
import { validateTenantId } from './tenantValidator.js';

// Create component-specific logger
const contextLogger = logger.createLogger({ prefix: 'TenantContext' });

/**
 * Tenant context stored in AsyncLocalStorage
 */
type TenantContext = {
    tenantId: string;
    originalTenantId?: string; // Track the original context for nesting
    switchDepth: number; // Track nesting depth
};

/**
 * AsyncLocalStorage instance for tenant context
 */
const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Tenant Context Manager
 * 
 * Provides dynamic tenant switching capabilities using AsyncLocalStorage.
 * This allows operations to temporarily switch tenant context while preserving
 * the original context for nested operations.
 */
export class TenantContextManager {
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
    async withTenant<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
        // Validate the tenant ID
        validateTenantId(tenantId);

        const currentContext = this.getCurrentContext();
        const isNestedSwitch = currentContext !== null;

        const newContext: TenantContext = {
            tenantId,
            originalTenantId: isNestedSwitch ? (currentContext.originalTenantId || currentContext.tenantId) : undefined,
            switchDepth: isNestedSwitch ? currentContext.switchDepth + 1 : 1
        };

        contextLogger.debug('Switching tenant context', {
            fromTenant: currentContext?.tenantId || 'none',
            toTenant: tenantId,
            isNested: isNestedSwitch,
            depth: newContext.switchDepth
        });

        try {
            return await tenantStorage.run(newContext, async () => {
                contextLogger.debug('Executing operation in tenant context', {
                    tenantId,
                    depth: newContext.switchDepth
                });

                const result = await operation();

                contextLogger.debug('Operation completed in tenant context', {
                    tenantId,
                    depth: newContext.switchDepth
                });

                return result;
            });
        } catch (error) {
            contextLogger.error('Operation failed in tenant context', error, {
                tenantId,
                depth: newContext.switchDepth,
                originalTenant: newContext.originalTenantId
            });
            throw error;
        } finally {
            contextLogger.debug('Exiting tenant context', {
                tenantId,
                depth: newContext.switchDepth,
                returningTo: currentContext?.tenantId || 'none'
            });
        }
    }

    /**
     * Get the current tenant ID from the async context
     * 
     * @returns The current tenant ID, or null if no context is set
     */
    getCurrentTenant(): string | null {
        const context = tenantStorage.getStore();
        return context?.tenantId || null;
    }

    /**
     * Get the original tenant ID (before any switches)
     * 
     * @returns The original tenant ID, or current tenant if no switches occurred
     */
    getOriginalTenant(): string | null {
        const context = tenantStorage.getStore();
        if (!context) return null;
        return context.originalTenantId || context.tenantId;
    }

    /**
     * Get the current tenant context depth
     * 
     * @returns The nesting depth of tenant switches (0 = no context)
     */
    getContextDepth(): number {
        const context = tenantStorage.getStore();
        return context?.switchDepth || 0;
    }

    /**
     * Check if currently in a switched tenant context
     * 
     * @returns True if in a switched context
     */
    isInSwitchedContext(): boolean {
        const context = tenantStorage.getStore();
        return context !== undefined && context.originalTenantId !== undefined;
    }

    /**
     * Get the complete current context (internal method)
     * 
     * @returns The current tenant context or null
     */
    private getCurrentContext(): TenantContext | null {
        return tenantStorage.getStore() || null;
    }

    /**
     * Execute an operation with elevated system privileges
     * 
     * WARNING: This should only be used for administrative operations
     * that need to access data across tenants.
     * 
     * @param operation - The operation to execute with system privileges
     * @returns Promise that resolves to the operation result
     */
    async withSystemPrivileges<T>(operation: () => Promise<T>): Promise<T> {
        const SYSTEM_TENANT = '__system__';

        contextLogger.warn('Executing operation with system privileges', {
            currentTenant: this.getCurrentTenant(),
            depth: this.getContextDepth()
        });

        return this.withTenant(SYSTEM_TENANT, operation);
    }

    /**
     * Execute an operation ensuring it runs in the original tenant context
     * (useful for cleanup operations that should revert to original context)
     * 
     * @param operation - The operation to execute in original context
     * @returns Promise that resolves to the operation result
     */
    async withOriginalTenant<T>(operation: () => Promise<T>): Promise<T> {
        const originalTenant = this.getOriginalTenant();
        if (!originalTenant) {
            throw new Error('No original tenant context available');
        }

        contextLogger.debug('Reverting to original tenant context', {
            currentTenant: this.getCurrentTenant(),
            originalTenant,
            depth: this.getContextDepth()
        });

        return this.withTenant(originalTenant, operation);
    }
}

/**
 * Global tenant context manager instance
 */
export const tenantContextManager = new TenantContextManager();

/**
 * Convenience function for tenant switching
 * 
 * @param tenantId - The tenant ID to switch to
 * @param operation - The operation to execute
 * @returns Promise that resolves to the operation result
 */
export const withTenant = <T>(tenantId: string, operation: () => Promise<T>): Promise<T> => {
    return tenantContextManager.withTenant(tenantId, operation);
};

/**
 * Convenience function for system operations
 * 
 * @param operation - The operation to execute with system privileges
 * @returns Promise that resolves to the operation result
 */
export const withSystemPrivileges = <T>(operation: () => Promise<T>): Promise<T> => {
    return tenantContextManager.withSystemPrivileges(operation);
};

/**
 * Get current tenant from async context
 * 
 * @returns Current tenant ID or null
 */
export const getCurrentTenant = (): string | null => {
    return tenantContextManager.getCurrentTenant();
}; 