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
export declare class DurableHandlerInvokerCore implements DurableHandlerInvoker {
    private readonly restoreCtx;
    constructor(restoreCtx: (tenantId: string, taskId: string) => Promise<any>);
    invoke(params: {
        tenantId: string;
        taskId: string;
        handlerName: string;
        input: unknown;
    }): Promise<unknown>;
}
