import { jest } from '@jest/globals';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { handleTasksSend } from '../src/api/rpc/tasksSend.js';
import { handleTasksInput } from '../src/api/rpc/tasksInput.js';
import { PluginManager } from '../src/plugin/pluginManager.js';

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

    it('uses the selected agent latency budget for the durable RPC root deadline', async () => {
        const latencyMs = 4 * 60 * 60_000;
        const findAgent = jest.spyOn(PluginManager, 'findAgent').mockReturnValue({
            resolved: {
                runtimeManifest: { budgets: { latencyMs } },
            },
        } as any);
        const awaitTaskTerminal = jest.fn(async () => ({ status: { state: 'completed' } }));
        mockEngine.startTask.mockResolvedValueOnce({ id: 't-long', status: { state: 'working' } });
        Object.assign(mockEngine, { awaitTaskTerminal });

        try {
            const res = fakeRes();
            await handleTasksSend({
                body: {
                    params: {
                        id: 't-long',
                        agentId: 'anac-cig-importer',
                        tenantId: 'tenant-a',
                    },
                    id: 2,
                },
                header: () => undefined,
            } as any, res);

            expect(findAgent).toHaveBeenCalledWith('anac-cig-importer');
            expect(awaitTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({
                taskId: 't-long',
                agentId: 'anac-cig-importer',
                timeoutMs: latencyMs + 30_000,
                timeoutSource: 'manifest-latency',
            }));
            expect(res.body?.result?.status?.state).toBe('completed');
        } finally {
            findAgent.mockRestore();
            delete (mockEngine as any).awaitTaskTerminal;
        }
    });

    it('handleTasksInput handles engine call and idempotency cache', async () => {
        const res = fakeRes();
        await handleTasksInput({ body: { params: { id: 't1', token: 'tok', input: { a: 1 }, tenantId: 'tenant-a' }, id: 2 }, header: () => undefined } as any, res);
        expect(mockEngine.resumeInput).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', taskId: 't1', token: 'tok' }));
        expect(res.body?.result).toEqual({ ok: true });
    });
});
