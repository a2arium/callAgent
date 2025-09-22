// JSON-RPC serverless endpoint: tasks/send and tasks/input
// Request shape: { jsonrpc: '2.0', method: 'tasks/send'|'tasks/input', params: { ... }, id?: string|number|null }

type JsonRpcId = string | number | null;

type SendParams = { id: string; input: unknown; tenantId?: string };
type InputParams = { id: string; token: string; input: unknown; tenantId?: string; idempotencyKey?: string };

type JsonRpcReq = { jsonrpc: '2.0'; method: 'tasks/send' | 'tasks/input'; params: SendParams | InputParams; id?: JsonRpcId };
type JsonRpcError = { code: number; message: string; data?: unknown };
type JsonRpcRes<TResult> = { jsonrpc: '2.0'; result?: TResult; error?: JsonRpcError; id: JsonRpcId };

type ResultPayload =
    | { id: string; status: 'completed'; output: unknown }
    | { id: string; status: 'failed'; error: string }
    | { id: string; status: 'input_required'; token: string };

function ok<TResult>(id: JsonRpcId, result: TResult): JsonRpcRes<TResult> {
    return { jsonrpc: '2.0', id, result };
}
function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcRes<never> {
    return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function handler(event: { body?: string }): Promise<{ statusCode: number; body: string }> {
    try {
        const logger = {
            debug: (m: string, meta?: Record<string, unknown>) => console.debug(`[rpc] ${m}`, meta || {}),
            info: (m: string, meta?: Record<string, unknown>) => console.info(`[rpc] ${m}`, meta || {}),
            warn: (m: string, meta?: Record<string, unknown>) => console.warn(`[rpc] ${m}`, meta || {}),
            error: (m: string, meta?: Record<string, unknown>) => console.error(`[rpc] ${m}`, meta || {})
        };
        const metrics = {
            incr: (_n: string, _v: number = 1, _t?: Record<string, string>) => { /* hook */ }
        };

        if (!event.body) return { statusCode: 200, body: JSON.stringify(err(null, -32600, 'Invalid Request: empty body')) };
        const req = JSON.parse(event.body) as JsonRpcReq;
        const rpcId = req.id ?? null;
        logger.info('request', { method: req.method });

        switch (req.method) {
            case 'tasks/send': {
                const { id: taskId, input, tenantId } = req.params as SendParams;
                if (!taskId) return { statusCode: 200, body: JSON.stringify(err(rpcId, -32602, 'Invalid params: id required')) };

                // Dynamic import to avoid hard dependency at build time
                const [{ TaskEngine }, { WorkingMemorySessionStore }] = await Promise.all([
                    import('@a2arium/callagent-core/dist/core/orchestration/taskEngine.js' as any),
                    import('@a2arium/callagent-memory-sql' as any)
                ] as any);
                const engine = new TaskEngine({ sessionStore: new (WorkingMemorySessionStore as any)() });
                const resultTask = await engine.startTask({ task: { id: taskId, input }, isStreaming: false });
                if (!resultTask) return { statusCode: 200, body: JSON.stringify(ok(rpcId, { id: taskId, status: 'failed', error: 'NO_TASK' } as ResultPayload)) };
                const state = resultTask.status?.state;
                if (state === 'input-required') {
                    metrics.incr('rpc.input_required');
                    return { statusCode: 200, body: JSON.stringify(ok(rpcId, { id: taskId, status: 'input_required', token: 'opaque' } as ResultPayload)) };
                }
                if (state === 'failed') {
                    metrics.incr('rpc.failed');
                    return { statusCode: 200, body: JSON.stringify(ok(rpcId, { id: taskId, status: 'failed', error: 'failed' } as ResultPayload)) };
                }
                metrics.incr('rpc.completed');
                return { statusCode: 200, body: JSON.stringify(ok(rpcId, { id: taskId, status: 'completed', output: { ok: true } } as ResultPayload)) };
            }

            case 'tasks/input': {
                const { id: taskId, token, input, tenantId } = req.params as InputParams;
                if (!taskId || !token) return { statusCode: 200, body: JSON.stringify(err(rpcId, -32602, 'Invalid params: id and token required')) };
                // Basic idempotency: if Idempotency-Key header present, store per (tenantId, taskId, token)
                // NOTE: implement persistence if needed using ChatIdempotency or a dedicated table.
                const [{ TaskEngine }, { WorkingMemorySessionStore }] = await Promise.all([
                    import('@a2arium/callagent-core/dist/core/orchestration/taskEngine.js' as any),
                    import('@a2arium/callagent-memory-sql' as any)
                ] as any);
                const engine = new TaskEngine({ sessionStore: new (WorkingMemorySessionStore as any)() });
                await engine.resumeInput({ tenantId: tenantId ?? 'default', taskId, token, input });
                metrics.incr('rpc.resume');
                return { statusCode: 200, body: JSON.stringify(ok(rpcId, { id: taskId, status: 'completed', output: { acknowledged: true } } as ResultPayload)) };
            }

            default:
                return { statusCode: 200, body: JSON.stringify(err(rpcId, -32601, 'Method not found', { method: (req as any).method })) };
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { statusCode: 200, body: JSON.stringify(err(null, -32603, 'Internal error', { message })) };
    }
}


