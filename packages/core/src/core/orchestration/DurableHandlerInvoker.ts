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
        return await invokeHandler(handlerName, ctx, { input });
    }
}


