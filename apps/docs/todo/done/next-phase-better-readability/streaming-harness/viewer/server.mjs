#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const host = args.host ?? '127.0.0.1';
const port = Number(args.port ?? 8787);

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);

        if (req.method === 'GET' && url.pathname === '/') {
            await sendFile(res, 'index.html', 'text/html; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/viewer.css') {
            await sendFile(res, 'viewer.css', 'text/css; charset=utf-8');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/viewer.js') {
            await sendFile(res, 'viewer.js', 'text/javascript; charset=utf-8');
            return;
        }

        if (req.method === 'POST' && url.pathname === '/proxy/rpc-stream') {
            await proxyRpcStream(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/proxy/rpc-json') {
            await proxyRpcJson(req, res);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/proxy/sse') {
            await proxyDirectSse(req, res, url);
            return;
        }

        sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
        sendErrorResponse(res, error);
    }
});

server.on('error', (error) => {
    console.error(`Streaming viewer failed to listen on http://${host}:${port}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

server.listen(port, host, () => {
    console.log(`Streaming viewer listening on http://${host}:${port}`);
});

async function proxyRpcStream(req, res) {
    const body = await readJson(req);
    const endpoint = stringField(body, 'endpoint');
    const method = stringField(body, 'method');
    const taskId = stringField(body, 'taskId');
    const tenantId = optionalStringField(body, 'tenantId');
    const agentId = optionalStringField(body, 'agentId');
    const visibility = body.visibility === 'debug' ? 'debug' : 'public';

    if (!endpoint || !method || !taskId) {
        sendJson(res, 400, { error: 'endpoint, method, and taskId are required' });
        return;
    }
    if (method !== 'tasks/sendSubscribe' && method !== 'tasks/resubscribe') {
        sendJson(res, 400, { error: 'method must be tasks/sendSubscribe or tasks/resubscribe' });
        return;
    }

    const rpcUrl = withVisibility(endpoint, visibility);
    const params = method === 'tasks/sendSubscribe'
        ? { id: taskId, tenantId, agentId, input: body.input ?? {} }
        : { id: taskId, tenantId };

    const upstream = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...headerRecord(body.headers),
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: `${taskId}:viewer`,
            method,
            params,
        }),
    });

    await pipeUpstreamSse(upstream, res);
}

async function proxyRpcJson(req, res) {
    const body = await readJson(req);
    const endpoint = stringField(body, 'endpoint');
    const method = stringField(body, 'method');
    const taskId = stringField(body, 'taskId');
    const tenantId = optionalStringField(body, 'tenantId');

    if (!endpoint || !method || !taskId) {
        sendJson(res, 400, { error: 'endpoint, method, and taskId are required' });
        return;
    }
    if (method !== 'tasks/input') {
        sendJson(res, 400, { error: 'method must be tasks/input' });
        return;
    }

    const token = stringField(body, 'token');
    if (!token) {
        sendJson(res, 400, { error: 'token is required for tasks/input' });
        return;
    }

    const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headerRecord(body.headers),
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: `${taskId}:input`,
            method,
            params: {
                id: taskId,
                tenantId,
                token,
                input: body.input ?? {},
            },
        }),
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(text);
}

async function proxyDirectSse(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target) {
        sendJson(res, 400, { error: 'url query parameter is required' });
        return;
    }

    const upstream = await fetch(target, {
        method: 'GET',
        headers: {
            Accept: 'text/event-stream',
            ...(req.headers['last-event-id'] ? { 'Last-Event-ID': String(req.headers['last-event-id']) } : {}),
        },
    });

    await pipeUpstreamSse(upstream, res);
}

async function pipeUpstreamSse(upstream, res) {
    if (!upstream.ok) {
        const text = await upstream.text();
        sendJson(res, upstream.status, { error: text || upstream.statusText });
        return;
    }
    if (!upstream.body) {
        sendJson(res, 502, { error: 'upstream response body was empty' });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    reqAbortOnClose(res, () => reader.cancel().catch(() => undefined));

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.writableEnded) break;
            res.write(Buffer.from(value));
        }
    } catch (error) {
        if (!res.headersSent) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        res.write(`event: proxy.error\n`);
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        console.error('SSE proxy stream failed after headers were sent:', message);
    } finally {
        if (!res.writableEnded) {
            res.end();
        }
    }
}

function reqAbortOnClose(res, abort) {
    res.on('close', () => {
        if (!res.writableEnded) abort();
    });
}

async function sendFile(res, name, contentType) {
    const content = await readFile(join(root, name));
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
    });
    res.end(content);
}

function sendJson(res, status, value) {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(value, null, 2));
}

function sendErrorResponse(res, error) {
    const payload = {
        error: error instanceof Error ? error.message : String(error),
    };
    if (res.writableEnded) {
        return;
    }
    if (res.headersSent) {
        try {
            res.write(`event: proxy.error\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            res.end();
        } catch {
            /* noop */
        }
        return;
    }
    sendJson(res, 500, payload);
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function withVisibility(endpoint, visibility) {
    const url = new URL(endpoint);
    if (visibility === 'debug') {
        url.searchParams.set('visibility', 'debug');
    } else {
        url.searchParams.delete('visibility');
    }
    return url.toString();
}

function stringField(record, key) {
    const value = record?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringField(record, key) {
    const value = stringField(record, key);
    return value && value.length > 0 ? value : undefined;
}

function headerRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const headers = {};
    for (const [key, headerValue] of Object.entries(value)) {
        if (typeof headerValue === 'string') {
            headers[key] = headerValue;
        }
    }
    return headers;
}

function parseArgs(argv) {
    const parsed = {};
    for (const arg of argv) {
        const match = /^--([^=]+)=(.*)$/.exec(arg);
        if (match) {
            parsed[match[1]] = match[2];
        }
    }
    return parsed;
}
