import { createApiRouter } from '../src/api/router.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';

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
        status: (code: number) => {
            res.statusCode = code;
            return res;
        },
        json: (body: any) => { res.body = body; },
    };
    return res;
};

describe('API router default branch', () => {
    afterEach(() => {
        EngineLocator.setEngine(null);
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
});
