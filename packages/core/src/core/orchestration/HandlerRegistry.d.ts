type HandlerFn = (ctx: any, ev: {
    input: unknown;
    token?: string;
}) => Promise<unknown> | unknown;
export declare function registerHandler(name: string, fn: HandlerFn): void;
export declare function unregisterHandler(name: string): void;
export declare function invokeHandler(name: string, ctx: any, ev: {
    input: unknown;
    token?: string;
}): Promise<unknown>;
export {};
