import {
    STREAM_ENDED_WITHOUT_TERMINAL_STATUS,
    consumeA2ASseAsChatResult,
    streamA2ASseRuntimeEvents,
} from '../internal/invokers/a2aSseChatStream.js';
import type { BridgeTaskInput, ChatSender, Invoker, ResultPayload, ResumeParams, RuntimeStreamSink, StartParams, StreamingInvoker } from '../types.js';
import type { RuntimeStreamEvent } from '@a2arium/callagent-core';
import { consumeRuntimeStreamAsResult } from '../internal/invokers/runtimeStreamResult.js';

type JsonRpcId = string | number | null;
type JsonRpcReq<T> = { jsonrpc: '2.0'; method: string; params: T; id?: JsonRpcId };
type JsonRpcRes<T> = { jsonrpc: '2.0'; result?: T; error?: { code: number; message: string; data?: unknown }; id: JsonRpcId };

type SendParams = { id: string; input: BridgeTaskInput; tenantId?: string };
type InputParams = { id: string; token: string; input: BridgeTaskInput; tenantId?: string; idempotencyKey?: string };
type ResubscribeParams = { id: string; tenantId?: string };
export type JsonRpcInvokerOptions = {
    endpoint: string;
    headers?: Record<string, string>;
    streaming?: boolean;
    chatSender?: ChatSender;
};

export class JsonRpcInvoker implements Invoker, StreamingInvoker {
    constructor(private readonly opts: JsonRpcInvokerOptions) { }

    async start(params: StartParams, sink?: RuntimeStreamSink): Promise<ResultPayload> {
        if (sink) {
            return consumeRuntimeStreamAsResult({
                taskId: params.id,
                events: this.startStream(params),
                sink,
            });
        }

        if (this.opts.streaming && this.opts.chatSender) {
            return this.startStreaming(params);
        }

        const body: JsonRpcReq<SendParams> = { jsonrpc: '2.0', method: 'tasks/send', params: { id: params.id, input: params.input, tenantId: params.tenantId }, id: params.id };
        const res = await fetch(this.opts.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) }, body: JSON.stringify(body) });
        const json = (await res.json()) as JsonRpcRes<ResultPayload>;
        if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
        return json.result as ResultPayload;
    }

    private async startStreaming(params: StartParams): Promise<ResultPayload> {
        const chatSender = this.opts.chatSender;
        if (!chatSender) {
            return { id: params.id, status: 'failed', error: 'Streaming JsonRpcInvoker requires chatSender' };
        }

        const body: JsonRpcReq<SendParams> = {
            jsonrpc: '2.0',
            method: 'tasks/sendSubscribe',
            params: { id: params.id, input: params.input, tenantId: params.tenantId },
            id: params.id,
        };
        const res = await fetch(this.opts.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...(this.opts.headers || {}),
            },
            body: JSON.stringify(body),
        });

        const contentType = res.headers?.get?.('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            const json = (await res.json()) as JsonRpcRes<ResultPayload>;
            if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
            return json.result as ResultPayload;
        }

        if (!res.body) {
            return { id: params.id, status: 'failed', error: 'Streaming response body was empty' };
        }

        return consumeA2ASseAsChatResult({
            body: res.body,
            taskId: params.id,
            tenantId: params.tenantId,
            route: params.route,
            chatSender,
        });
    }

    async *startStream(params: StartParams): AsyncIterable<RuntimeStreamEvent> {
        const body: JsonRpcReq<SendParams> = {
            jsonrpc: '2.0',
            method: 'tasks/sendSubscribe',
            params: { id: params.id, input: params.input, tenantId: params.tenantId },
            id: params.id,
        };
        const res = await this.fetchSse(body);
        yield* streamA2ASseRuntimeEvents({
            body: res.body,
            taskId: params.id,
            tenantId: params.tenantId,
        });
    }

    async resume(params: ResumeParams, sink?: RuntimeStreamSink): Promise<ResultPayload> {
        if (sink) {
            return consumeRuntimeStreamAsResult({
                taskId: params.id,
                events: this.resumeStream(params),
                sink,
            });
        }

        if (this.opts.streaming && this.opts.chatSender) {
            return this.resumeStreaming(params);
        }

        const body: JsonRpcReq<InputParams> = { jsonrpc: '2.0', method: 'tasks/input', params: { id: params.id, token: params.token, input: params.input, tenantId: params.tenantId }, id: params.id };
        const res = await fetch(this.opts.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) }, body: JSON.stringify(body) });
        const json = (await res.json()) as JsonRpcRes<ResultPayload>;
        if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
        return json.result as ResultPayload;
    }

    private async resumeStreaming(params: ResumeParams): Promise<ResultPayload> {
        const chatSender = this.opts.chatSender;
        if (!chatSender) {
            return { id: params.id, status: 'failed', error: 'Streaming JsonRpcInvoker requires chatSender' };
        }

        const subscribeBody: JsonRpcReq<ResubscribeParams> = {
            jsonrpc: '2.0',
            method: 'tasks/resubscribe',
            params: { id: params.id, tenantId: params.tenantId },
            id: `${params.id}:resubscribe`,
        };
        const streamRes = await fetch(this.opts.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...(this.opts.headers || {}),
            },
            body: JSON.stringify(subscribeBody),
        });

        const contentType = streamRes.headers?.get?.('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            const json = (await streamRes.json()) as JsonRpcRes<ResultPayload>;
            if (json.error) return { id: params.id, status: 'failed', error: json.error.message };
            return json.result as ResultPayload;
        }
        if (!streamRes.body) {
            return { id: params.id, status: 'failed', error: 'Streaming response body was empty' };
        }

        const inputBody: JsonRpcReq<InputParams> = {
            jsonrpc: '2.0',
            method: 'tasks/input',
            params: { id: params.id, token: params.token, input: params.input, tenantId: params.tenantId },
            id: params.id,
        };
        const inputResult = fetch(this.opts.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) },
            body: JSON.stringify(inputBody),
        }).then(async (res) => {
            const json = (await res.json()) as JsonRpcRes<ResultPayload>;
            return json.error
                ? { id: params.id, status: 'failed' as const, error: json.error.message }
                : json.result as ResultPayload;
        });

        const streamResult = await consumeA2ASseAsChatResult({
            body: streamRes.body,
            taskId: params.id,
            tenantId: params.tenantId,
            route: params.route,
            chatSender,
        });
        if (streamResult.status !== 'failed' || streamResult.error !== STREAM_ENDED_WITHOUT_TERMINAL_STATUS) {
            return streamResult;
        }

        return inputResult;
    }

    async *resumeStream(params: ResumeParams): AsyncIterable<RuntimeStreamEvent> {
        const subscribeBody: JsonRpcReq<ResubscribeParams> = {
            jsonrpc: '2.0',
            method: 'tasks/resubscribe',
            params: { id: params.id, tenantId: params.tenantId },
            id: `${params.id}:resubscribe`,
        };
        const streamRes = await this.fetchSse(subscribeBody);

        const inputBody: JsonRpcReq<InputParams> = {
            jsonrpc: '2.0',
            method: 'tasks/input',
            params: { id: params.id, token: params.token, input: params.input, tenantId: params.tenantId },
            id: params.id,
        };
        const inputResult = fetch(this.opts.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.opts.headers || {}) },
            body: JSON.stringify(inputBody),
        }).then(async (res) => {
            const json = (await res.json()) as JsonRpcRes<ResultPayload>;
            if (json.error) {
                throw new Error(json.error.message);
            }
        });

        try {
            yield* streamA2ASseRuntimeEvents({
                body: streamRes.body,
                taskId: params.id,
                tenantId: params.tenantId,
            });
        } finally {
            await inputResult;
        }
    }

    private async fetchSse<T>(body: JsonRpcReq<T>): Promise<{ body: ReadableStream<Uint8Array> }> {
        const res = await fetch(this.opts.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...(this.opts.headers || {}),
            },
            body: JSON.stringify(body),
        });
        const contentType = res.headers?.get?.('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            const json = (await res.json()) as JsonRpcRes<ResultPayload>;
            throw new Error(json.error?.message ?? 'Expected text/event-stream response');
        }
        if (!res.body) {
            throw new Error('Streaming response body was empty');
        }
        return { body: res.body };
    }
}
