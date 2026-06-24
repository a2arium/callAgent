import { createApiRouter } from '../src/api/router.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { defaultMetricsRegistry } from '../src/observability/metrics.js';

const getRpcHandler = () => {
    const router = createApiRouter() as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/rpc');
    return layer.route.stack[0].handle;
};

const getHandler = (path: string, method: string) => {
    const router = createApiRouter() as any;
    const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
    return layer.route.stack[0].handle;
};

const fakeRes = () => {
    const res: any = {
        statusCode: 200,
        headers: {},
        writableEnded: false,
        status: (code: number) => {
            res.statusCode = code;
            return res;
        },
        json: (body: any) => { res.body = body; },
        setHeader: (name: string, value: unknown) => {
            res.headers[name] = value;
            return res;
        },
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(() => {
            res.writableEnded = true;
        }),
    };
    return res;
};

describe('API router default branch', () => {
    afterEach(() => {
        EngineLocator.setEngine(null);
        defaultMetricsRegistry.reset();
        delete process.env.CALLAGENT_METRICS_ENABLED;
        delete process.env.CALLAGENT_MODE;
        delete process.env.CALLAGENT_OPERATOR_AUTH_TOKEN;
        delete process.env.CALLAGENT_OPERATOR_ALLOWED_TENANTS;
        delete process.env.CALLAGENT_OPERATOR_TENANT_ID;
        delete process.env.CALLAGENT_RPC_PUBLIC;
    });

    it('returns method not found for unknown methods', async () => {
        const handler = getRpcHandler();
        const res = fakeRes();
        await handler({ body: { method: 'unknown', id: 5 } }, res);
        expect(res.body?.error?.code).toBe(-32601);
        expect(res.body?.id).toBe(5);
    });

    it('cancels a task through the operator endpoint', async () => {
        const cancelTask = jest.fn(async () => ({ acknowledged: true }));
        EngineLocator.setEngine({ cancelTask });
        const handler = getHandler('/tasks/:taskId/cancel', 'post');
        const res = fakeRes();

        await handler({
            params: { taskId: 'task-1' },
            query: {},
            body: { reason: 'operator stop', agentId: 'agent-1' },
            header: (name: string) => name === 'x-tenant-id' ? 'tenant-1' : undefined,
        }, res);

        expect(res.statusCode).toBe(200);
        expect(cancelTask).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            reason: 'operator stop',
        });
        expect(res.body).toEqual({ acknowledged: true });
    });

    it('exposes operator API metrics', async () => {
        const listAgentRuns = jest.fn(async () => ({ items: [], nextCursor: null }));
        EngineLocator.setEngine({ listAgentRuns });
        const agentRunsHandler = getHandler('/agent-runs', 'get');
        const metricsHandler = getHandler('/metrics', 'get');
        const res = fakeRes();

        await agentRunsHandler({
            method: 'GET',
            query: { tenantId: 'tenant-1' },
            header: () => undefined,
        }, res);

        const metricsRes = fakeRes();
        await metricsHandler({ method: 'GET' }, metricsRes);

        expect(metricsRes.body.ok).toBe(true);
        expect(metricsRes.body.metrics.counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'operator.api_request_total',
                count: 1,
                dimensions: expect.objectContaining({ route: 'agent-runs', method: 'GET' }),
            }),
        ]));
        expect(metricsRes.body.metrics.durations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'operator.api_request_ms',
                dimensions: expect.objectContaining({ route: 'agent-runs', method: 'GET', status: '200' }),
            }),
        ]));
    });

    it('can disable the metrics endpoint by config', async () => {
        process.env.CALLAGENT_METRICS_ENABLED = 'false';
        const metricsHandler = getHandler('/metrics', 'get');
        const res = fakeRes();

        await metricsHandler({ method: 'GET' }, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            ok: false,
            error: 'Metrics endpoint is disabled',
        });
    });

    it('rejects operator requests in production without a configured token', async () => {
        process.env.CALLAGENT_MODE = 'production';
        const handler = getHandler('/agent-runs', 'get');
        const res = fakeRes();

        await handler({
            method: 'GET',
            query: { tenantId: 'tenant-1' },
            header: () => undefined,
        }, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(expect.objectContaining({
            error: 'OPERATOR_AUTH_NOT_CONFIGURED',
        }));
    });

    it('requires the configured operator token in production', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        const listAgentRuns = jest.fn(async () => ({ items: [], nextCursor: null }));
        EngineLocator.setEngine({ listAgentRuns });
        const handler = getHandler('/agent-runs', 'get');

        const rejected = fakeRes();
        await handler({
            method: 'GET',
            query: { tenantId: 'tenant-1' },
            header: () => undefined,
        }, rejected);
        expect(rejected.statusCode).toBe(401);

        const accepted = fakeRes();
        await handler({
            method: 'GET',
            query: { tenantId: 'tenant-1' },
            header: (name: string) => name === 'x-callagent-operator-key' ? 'secret' : undefined,
        }, accepted);
        expect(accepted.statusCode).toBe(200);
        expect(listAgentRuns).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('requires auth for every operator endpoint in production', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        process.env.CALLAGENT_OPERATOR_TENANT_ID = 'tenant-1';
        const cases = [
            { path: '/metrics', method: 'get', req: { method: 'GET', header: () => undefined } },
            { path: '/agent-runs', method: 'get', req: { method: 'GET', query: {}, header: () => undefined } },
            { path: '/agents', method: 'get', req: { method: 'GET', query: {}, header: () => undefined } },
            { path: '/tasks/:taskId/run-graph', method: 'get', req: { method: 'GET', params: { taskId: 'task-1' }, query: {}, header: () => undefined } },
            { path: '/tasks/:taskId/cancel', method: 'post', req: { method: 'POST', params: { taskId: 'task-1' }, query: {}, body: {}, header: () => undefined } },
            { path: '/tasks/:taskId/turns/:turnSeq', method: 'get', req: { method: 'GET', params: { taskId: 'task-1', turnSeq: '1' }, query: {}, header: () => undefined } },
            { path: '/tasks/:taskId/memory', method: 'get', req: { method: 'GET', params: { taskId: 'task-1' }, query: {}, header: () => undefined } },
        ];

        for (const item of cases) {
            const handler = getHandler(item.path, item.method);
            const res = fakeRes();
            await handler(item.req, res);
            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual(expect.objectContaining({ error: 'OPERATOR_AUTH_REQUIRED' }));
        }
    });

    it('rejects tenants outside the configured allowed tenant set', async () => {
        process.env.CALLAGENT_OPERATOR_ALLOWED_TENANTS = 'tenant-allowed';
        const handler = getHandler('/agent-runs', 'get');
        const res = fakeRes();

        await handler({
            method: 'GET',
            query: { tenantId: 'tenant-denied' },
            header: () => undefined,
        }, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({ error: 'TENANT_NOT_ALLOWED' }));
    });

    it('uses the server configured operator tenant and rejects mismatches', async () => {
        process.env.CALLAGENT_OPERATOR_TENANT_ID = 'tenant-server';
        const listAgentRuns = jest.fn(async () => ({ items: [], nextCursor: null }));
        EngineLocator.setEngine({ listAgentRuns });
        const handler = getHandler('/agent-runs', 'get');

        const accepted = fakeRes();
        await handler({
            method: 'GET',
            query: {},
            header: () => undefined,
        }, accepted);
        expect(accepted.statusCode).toBe(200);
        expect(listAgentRuns).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-server' }));

        const rejected = fakeRes();
        await handler({
            method: 'GET',
            query: { tenantId: 'tenant-other' },
            header: () => undefined,
        }, rejected);
        expect(rejected.statusCode).toBe(403);
        expect(rejected.body).toEqual(expect.objectContaining({ error: 'TENANT_NOT_ALLOWED' }));
    });

    it('rejects conflicting tenant identifiers', async () => {
        const handler = getHandler('/tasks/:taskId/run-graph', 'get');
        const res = fakeRes();

        await handler({
            method: 'GET',
            params: { taskId: 'task-1' },
            query: { tenantId: 'tenant-query' },
            header: (name: string) => name === 'x-tenant-id' ? 'tenant-header' : undefined,
        }, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(expect.objectContaining({ error: 'TENANT_CONFLICT' }));
    });

    it('writes an audit record for operator cancel', async () => {
        const cancelTask = jest.fn(async () => ({ acknowledged: true }));
        const create = jest.fn(async () => ({}));
        EngineLocator.setEngine({
            cancelTask,
            getOperatorPrismaClient: () => ({ operatorAuditEvent: { create } }),
        });
        const handler = getHandler('/tasks/:taskId/cancel', 'post');
        const res = fakeRes();

        await handler({
            method: 'POST',
            params: { taskId: 'task-1' },
            query: {},
            body: { reason: 'operator stop', agentId: 'agent-1' },
            header: (name: string) => name === 'x-tenant-id' ? 'tenant-1' : undefined,
        }, res);

        expect(res.statusCode).toBe(200);
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'agent.cancel',
                actorType: 'dev-local',
                actorId: 'dev-local',
                taskId: 'task-1',
                agentId: 'agent-1',
                reason: 'operator stop',
                accepted: true,
                resultStatus: 'requested',
            }),
        });
    });

    it('writes an audit record for operator raw payload launch', async () => {
        const startTask = jest.fn(async () => ({ id: 'task-1', status: { state: 'completed' } }));
        const create = jest.fn(async () => ({}));
        EngineLocator.setEngine({
            startTask,
            getOperatorPrismaClient: () => ({ operatorAuditEvent: { create } }),
        });
        const handler = getRpcHandler();
        const res = fakeRes();

        await handler({
            method: 'POST',
            body: {
                id: 1,
                method: 'tasks/send',
                params: { id: 'task-1', agentId: 'agent-1', url: 'https://example.test' },
            },
            header: (name: string) => {
                if (name === 'x-callagent-operator-launch') return 'true';
                if (name === 'x-tenant-id') return 'tenant-1';
                return undefined;
            },
        }, res);

        expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'payload.launch',
                taskId: 'task-1',
                agentId: 'agent-1',
                accepted: true,
                resultStatus: 'requested',
            }),
        });
    });

    it('protects production tasks/send even without the operator launch marker', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        process.env.CALLAGENT_OPERATOR_TENANT_ID = 'tenant-1';
        const handler = getRpcHandler();

        const rejected = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/send', params: { id: 'task-1', agentId: 'agent-1' } },
            header: () => undefined,
        }, rejected);
        expect(rejected.statusCode).toBe(401);
        expect(rejected.body).toEqual(expect.objectContaining({ error: 'OPERATOR_AUTH_REQUIRED' }));

        const startTask = jest.fn(async () => ({ id: 'task-1', status: { state: 'completed' } }));
        const create = jest.fn(async () => ({}));
        EngineLocator.setEngine({
            startTask,
            getOperatorPrismaClient: () => ({ operatorAuditEvent: { create } }),
        });
        const accepted = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/send', params: { id: 'task-1', agentId: 'agent-1' } },
            header: (name: string) => name === 'x-callagent-operator-key' ? 'secret' : undefined,
        }, accepted);

        expect(accepted.statusCode).toBe(200);
        expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'payload.launch',
                resultStatus: 'requested',
            }),
        });
    });

    it('protects production tasks/sendSubscribe and audits launch', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        process.env.CALLAGENT_OPERATOR_TENANT_ID = 'tenant-1';
        const handler = getRpcHandler();

        const rejected = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/sendSubscribe', params: { id: 'task-1', agentId: 'agent-1' } },
            header: () => undefined,
        }, rejected);
        expect(rejected.statusCode).toBe(401);

        const startTask = jest.fn(async () => ({ id: 'task-1' }));
        const create = jest.fn(async () => ({}));
        EngineLocator.setEngine({
            startTask,
            getOperatorPrismaClient: () => ({ operatorAuditEvent: { create } }),
        });
        const accepted = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/sendSubscribe', params: { id: 'task-1', agentId: 'agent-1' } },
            header: (name: string) => name === 'x-callagent-operator-key' ? 'secret' : undefined,
            get: () => undefined,
            query: {},
            on: jest.fn(),
        }, accepted);

        expect(startTask).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            isStreaming: true,
        }));
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'payload.launch',
                taskId: 'task-1',
                resultStatus: 'requested',
            }),
        });
    });

    it('protects production tasks/input and propagates the server tenant', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        process.env.CALLAGENT_OPERATOR_TENANT_ID = 'tenant-1';
        const resumeInput = jest.fn(async () => ({ ok: true }));
        EngineLocator.setEngine({ resumeInput });
        const handler = getRpcHandler();

        const rejected = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/input', params: { id: 'task-1', token: 'tok', input: { ok: true } } },
            header: () => undefined,
        }, rejected);
        expect(rejected.statusCode).toBe(401);

        const accepted = fakeRes();
        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/input', params: { id: 'task-1', token: 'tok', input: { ok: true } } },
            header: (name: string) => name === 'x-callagent-operator-key' ? 'secret' : undefined,
        }, accepted);

        expect(accepted.body?.result).toEqual({ ok: true });
        expect(resumeInput).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'tok',
        }));
    });

    it('allows public production RPC only when explicitly configured', async () => {
        process.env.CALLAGENT_MODE = 'production';
        process.env.CALLAGENT_OPERATOR_AUTH_TOKEN = 'secret';
        process.env.CALLAGENT_RPC_PUBLIC = 'true';
        const startTask = jest.fn(async () => ({ id: 'task-1', status: { state: 'completed' } }));
        EngineLocator.setEngine({ startTask });
        const handler = getRpcHandler();
        const res = fakeRes();

        await handler({
            method: 'POST',
            body: { id: 1, method: 'tasks/send', params: { id: 'task-1', agentId: 'agent-1', tenantId: 'tenant-public' } },
            header: () => undefined,
        }, res);

        expect(res.statusCode).toBe(200);
        expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-public' }));
    });
});
