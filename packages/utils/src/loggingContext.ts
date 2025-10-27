/**
 * Async Local Storage for Logging Context
 * Provides automatic context propagation for logging across async boundaries
 */

import { AsyncLocalStorage } from 'async_hooks';

export type LoggingContext = {
    /** Unique task/request ID for correlation */
    taskId?: string;
    /** Tenant ID for multi-tenant isolation */
    tenantId?: string;
    /** Agent ID for agent identification */
    agentId?: string;
    /** Parent task ID for hierarchical tracing */
    parentTaskId?: string;
    /** Correlation ID for distributed tracing */
    correlationId?: string;
    /** Current turn number in loop-based execution */
    turn?: number;
    /** Current stage in agent workflow */
    stage?: string;
    /** Any additional contextual data */
    [key: string]: unknown;
};

// Global async storage for logging context
export const loggingContext = new AsyncLocalStorage<LoggingContext>();

/**
 * Establish a logging context for all operations within the callback.
 * Context is automatically propagated through async operations.
 * 
 * @param context - Context data to establish
 * @param fn - Function to execute within the context
 * @returns Result of the function
 * 
 * @example
 * ```typescript
 * return withLoggingContext(
 *   { taskId: '123', tenantId: 'acme', agentId: 'hello-agent' },
 *   async () => {
 *     logger.info('Processing task'); // Automatically includes context
 *     await doWork();
 *     logger.info('Task completed'); // Still has context
 *   }
 * );
 * ```
 */
export function withLoggingContext<T>(
    context: LoggingContext,
    fn: () => T | Promise<T>
): T | Promise<T> {
    // Merge with parent context if it exists (for nested contexts)
    const parentContext = loggingContext.getStore();
    const mergedContext = { ...parentContext, ...context };
    
    return loggingContext.run(mergedContext, fn);
}

/**
 * Get the current logging context (if any).
 * Returns undefined if not within a logging context.
 * 
 * @returns Current logging context or undefined
 * 
 * @example
 * ```typescript
 * const context = getLoggingContext();
 * if (context) {
 *   console.log('Task ID:', context.taskId);
 * }
 * ```
 */
export function getLoggingContext(): LoggingContext | undefined {
    return loggingContext.getStore();
}

/**
 * Update the current logging context with new data.
 * Merges the updates with existing context.
 * Only works within an established context.
 * 
 * @param updates - Partial context updates to apply
 * 
 * @example
 * ```typescript
 * // Update turn number as loop progresses
 * updateLoggingContext({ turn: 2 });
 * 
 * // Update stage as workflow progresses
 * updateLoggingContext({ stage: 'executing' });
 * ```
 */
export function updateLoggingContext(updates: Partial<LoggingContext>): void {
    const current = loggingContext.getStore();
    if (current) {
        Object.assign(current, updates);
    }
}

/**
 * Check if we're currently within a logging context
 * 
 * @returns True if within a logging context
 */
export function hasLoggingContext(): boolean {
    return loggingContext.getStore() !== undefined;
}

