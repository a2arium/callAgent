export interface DurableHandlerInvoker {
    /**
     * Invoke a durable handler by name for a given task session.
     * Implementations should restore full WM into ctx and call the exported handler function.
     */
    invoke(params: {
        tenantId: string;
        taskId: string;
        handlerName: string;
        input: unknown;
    }): Promise<unknown>;
}

export class DurableHandlerInvokerCore implements DurableHandlerInvoker {
    constructor(private readonly restoreCtx: (tenantId: string, taskId: string) => Promise<any>) { }

    async invoke(params: { tenantId: string; taskId: string; handlerName: string; input: unknown }): Promise<unknown> {
        const { tenantId, taskId, handlerName, input } = params;
        const ctx = await this.restoreCtx(tenantId, taskId);
        const { invokeHandler } = await import('./HandlerRegistry.js');
        // Temporarily mirror console.log from durable handlers to stdout with context prefix
        const originalLog = console.log;
        const originalLogger = (ctx as any).logger;
        try {
            console.log = (...args: unknown[]) => {
                try { originalLog(`[handler:${handlerName} task:${taskId}]`, ...args); } catch { originalLog(...args as []); }
            };
            // Mirror framework logger to stdout as well
            if (originalLogger && typeof originalLogger === 'object') {
                (ctx as any).logger = {
                    debug: (msg: string, ...args: unknown[]) => { try { originalLogger.debug?.(msg, ...args); } catch { } originalLog(`[handler:${handlerName} task:${taskId}]`, msg, ...args); },
                    info: (msg: string, ...args: unknown[]) => { try { originalLogger.info?.(msg, ...args); } catch { } originalLog(`[handler:${handlerName} task:${taskId}]`, msg, ...args); },
                    warn: (msg: string, ...args: unknown[]) => { try { originalLogger.warn?.(msg, ...args); } catch { } originalLog(`[handler:${handlerName} task:${taskId}]`, msg, ...args); },
                    error: (msg: string, error?: unknown, context?: Record<string, unknown>) => { try { originalLogger.error?.(msg, error, context); } catch { } originalLog(`[handler:${handlerName} task:${taskId}]`, msg, error, context); }
                };
            }
            return await invokeHandler(handlerName, ctx, { input });
        } finally {
            console.log = originalLog;
            if (originalLogger) (ctx as any).logger = originalLogger;
        }
    }
}


