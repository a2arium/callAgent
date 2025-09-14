type HandlerFn = (ctx: any, ev: { input: unknown; token?: string }) => Promise<unknown> | unknown;

const registry = new Map<string, HandlerFn>();

export function registerHandler(name: string, fn: HandlerFn): void {
    registry.set(name, fn);
    try { console.log(`[HandlerRegistry] Registered handler: ${name}`); } catch { }
}

export function unregisterHandler(name: string): void {
    registry.delete(name);
}

export async function invokeHandler(name: string, ctx: any, ev: { input: unknown; token?: string }): Promise<unknown> {
    const fn = registry.get(name);
    if (!fn) {
        try { console.warn(`[HandlerRegistry] Handler not found: ${name}. Registered: ${Array.from(registry.keys()).join(', ')}`); } catch { }
        throw new Error(`HANDLER_NOT_FOUND: ${name}`);
    }
    try { console.log(`[HandlerRegistry] Invoking handler: ${name}`); } catch { }
    return await Promise.resolve(fn(ctx, ev));
}


