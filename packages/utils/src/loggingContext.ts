/**
 * Async Local Storage for Logging Context
 * Provides automatic context propagation for logging across async boundaries
 */

import { AsyncLocalStorage } from 'async_hooks';
import { inspect } from 'util';

export type LoggingSinkLevel = 'debug' | 'info' | 'warn' | 'error';

export type LoggingSinkEntry = {
    level: LoggingSinkLevel;
    message: string;
    context?: Omit<LoggingContext, 'logSink'>;
};

export type LoggingSink = (entry: LoggingSinkEntry) => void | Promise<void>;

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
    /** Optional sink for forwarding scoped console/logger output to an external runtime. */
    logSink?: LoggingSink;
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

let consoleBridgeInstalled = false;
let forwardingToSink = false;
let consoleSinkSuppressed = 0;
let originalConsole: Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'> | undefined;

/**
 * Install a process-wide console bridge that mirrors console output to the current
 * async logging context sink, when one is present.
 *
 * The patch is intentionally inert unless `withLoggingContext({ logSink })` is
 * active, so normal CLI behavior remains stdout/stderr only.
 */
export function installLoggingContextConsoleBridge(): void {
    if (consoleBridgeInstalled) {
        return;
    }
    consoleBridgeInstalled = true;
    originalConsole = {
        debug: console.debug.bind(console),
        info: console.info.bind(console),
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    console.debug = (...args: unknown[]) => {
        originalConsole!.debug(...args);
        emitConsoleArgsToLoggingSink('debug', args);
    };
    console.info = (...args: unknown[]) => {
        originalConsole!.info(...args);
        emitConsoleArgsToLoggingSink('info', args);
    };
    console.log = (...args: unknown[]) => {
        originalConsole!.log(...args);
        emitConsoleArgsToLoggingSink('info', args);
    };
    console.warn = (...args: unknown[]) => {
        originalConsole!.warn(...args);
        emitConsoleArgsToLoggingSink('warn', args);
    };
    console.error = (...args: unknown[]) => {
        originalConsole!.error(...args);
        emitConsoleArgsToLoggingSink('error', args);
    };
}

export function withConsoleSinkSuppressed<T>(fn: () => T | Promise<T>): T | Promise<T> {
    consoleSinkSuppressed++;

    try {
        const result = fn();
        if (result && typeof (result as Promise<T>).then === 'function') {
            return (result as Promise<T>).finally(() => {
                consoleSinkSuppressed = Math.max(0, consoleSinkSuppressed - 1);
            });
        }
        consoleSinkSuppressed = Math.max(0, consoleSinkSuppressed - 1);
        return result;
    } catch (error) {
        consoleSinkSuppressed = Math.max(0, consoleSinkSuppressed - 1);
        throw error;
    }
}

function emitConsoleArgsToLoggingSink(level: LoggingSinkLevel, args: unknown[]): void {
    if (forwardingToSink || consoleSinkSuppressed > 0) {
        return;
    }
    const context = getLoggingContext();
    const sink = context?.logSink;
    if (!sink) {
        return;
    }

    const { logSink: _logSink, ...contextForSink } = context;
    const message = formatConsoleArgs(args);
    forwardingToSink = true;
    try {
        const result = sink({ level, message, context: contextForSink });
        if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((error) => {
                originalConsole?.warn(
                    '[LoggingContext] Failed to forward console log to sink',
                    error instanceof Error ? error.message : String(error)
                );
            });
        }
    } catch (error) {
        originalConsole?.warn(
            '[LoggingContext] Failed to forward console log to sink',
            error instanceof Error ? error.message : String(error)
        );
    } finally {
        forwardingToSink = false;
    }
}

function formatConsoleArgs(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === 'string') {
                return arg;
            }
            if (arg instanceof Error) {
                return arg.stack ?? arg.message;
            }
            return inspect(arg, { depth: 4, breakLength: 120, compact: true });
        })
        .join(' ');
}
