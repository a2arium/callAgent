import type { ChatRoute, Invoker, ResultPayload } from '../types.js';

type JsonRpcId = string | number | null;
type JsonRpcReq<T> = { jsonrpc: '2.0'; method: string; params: T; id?: JsonRpcId };
type JsonRpcRes<T> = { jsonrpc: '2.0'; result?: T; error?: { code: number; message: string; data?: unknown }; id: JsonRpcId };

type SendParams = { id: string; input: unknown; tenantId?: string };
type InputParams = { id: string; token: string; input: unknown; tenantId?: string; idempotencyKey?: string };

export class JsonRpcInvoker implements Invoker {
    constructor(private readonly opts: { endpoint: string; headers?: Record<string, string> }) { }

    async start(params: { id: string; input: unknown; agentId: string; tenantId?: string; route: ChatRoute }): Promise<ResultPayload> {
        const body: JsonRpcReq<SendParams> = { jsonrpc: '2.0', method: 'tasks/send', params: { id: params.id, input: params.input, tenantId: params.tenantId }, id: params.id };
        const res = await fetch(this.opts.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) }, body: JSON.stringify(body) });
        const json = (await res.json()) as JsonRpcRes<ResultPayload>;
        if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
        return json.result as ResultPayload;
    }

    async resume(params: { id: string; token: string; input: unknown; tenantId?: string; route: ChatRoute }): Promise<ResultPayload> {
        const body: JsonRpcReq<InputParams> = { jsonrpc: '2.0', method: 'tasks/input', params: { id: params.id, token: params.token, input: params.input, tenantId: params.tenantId }, id: params.id };
        const res = await fetch(this.opts.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) }, body: JSON.stringify(body) });
        const json = (await res.json()) as JsonRpcRes<ResultPayload>;
        if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
        return json.result as ResultPayload;
    }
}


