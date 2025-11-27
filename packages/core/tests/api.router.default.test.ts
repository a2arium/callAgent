import { createApiRouter } from '../src/api/router.js';

const getRpcHandler = () => {
    const router = createApiRouter() as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/rpc');
    return layer.route.stack[0].handle;
};

const fakeRes = () => {
    const res: any = { json: (body: any) => { res.body = body; } };
    return res;
};

describe('API router default branch', () => {
    it('returns method not found for unknown methods', async () => {
        const handler = getRpcHandler();
        const res = fakeRes();
        await handler({ body: { method: 'unknown', id: 5 } }, res);
        expect(res.body?.error?.code).toBe(-32601);
        expect(res.body?.id).toBe(5);
    });
});
