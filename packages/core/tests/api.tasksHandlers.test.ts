import { jest } from '@jest/globals';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { handleTasksSend } from '../src/api/rpc/tasksSend.js';
import { handleTasksInput } from '../src/api/rpc/tasksInput.js';

const fakeRes = () => {
    const res: any = { json: (body: any) => { res.body = body; } };
    return res;
};

describe('API RPC handlers', () => {
    const mockEngine = {
        startTask: jest.fn(async () => ({ id: 't1', status: { state: 'completed' } })),
        resumeInput: jest.fn(async () => ({ ok: true }))
    };

    beforeEach(() => {
        EngineLocator.setEngine(mockEngine);
        jest.clearAllMocks();
    });

    it('handleTasksSend validates params and returns result', async () => {
        const res = fakeRes();
        await handleTasksSend({ body: { params: { id: 't1', foo: 'bar', agentId: 'agent-a', tenantId: 'tenant-a' }, id: 1 } } as any, res);
        expect(mockEngine.startTask).toHaveBeenCalledWith(expect.objectContaining({
            agentId: 'agent-a',
            tenantId: 'tenant-a',
            task: expect.objectContaining({ id: 't1' }),
        }));
        expect(res.body?.result?.status?.state).toBe('completed');
    });

    it('handleTasksInput handles engine call and idempotency cache', async () => {
        const res = fakeRes();
        await handleTasksInput({ body: { params: { id: 't1', token: 'tok', input: { a: 1 }, tenantId: 'tenant-a' }, id: 2 }, header: () => undefined } as any, res);
        expect(mockEngine.resumeInput).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', taskId: 't1', token: 'tok' }));
        expect(res.body?.result).toEqual({ ok: true });
    });
});
