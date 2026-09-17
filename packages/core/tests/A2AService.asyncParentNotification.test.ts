import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { A2AService } from '../src/orchestration/A2AService.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { PluginManager } from '../src/plugin/pluginManager.js';

describe('A2AService async parent notification', () => {
    let service: A2AService;
    const handleChildCompleted = jest.fn<(...args: any[]) => Promise<void>>();

    beforeEach(() => {
        jest.spyOn(A2AService.prototype as any, 'initializeCacheService').mockResolvedValue(undefined);
        service = new A2AService();
        handleChildCompleted.mockResolvedValue(undefined);
        jest.spyOn(EngineLocator, 'getEngine').mockReturnValue({
            attachWorkingMemory: jest.fn(),
            flushContextSnapshot: jest.fn(),
            handleChildCompleted,
        } as any);
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue({
            manifest: { name: 'child-agent', version: '1.0.0' },
            resolved: {
                agentCard: { name: 'child-agent', version: '1.0.0' },
                runtimeManifest: { name: 'child-agent', version: '1.0.0' },
            },
            handleTask: jest.fn(async (ctx: any) => ({
                id: ctx.task.id,
                input: ctx.task.input,
                status: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { ok: true } },
                },
            })),
        } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        handleChildCompleted.mockReset();
    });

    it('does not create a second dispatch-path producer for runtime-owned async children', async () => {
        const sourceCtx = {
            tenantId: 'tenant-a',
            agentId: 'parent-agent',
            task: { id: 'parent-task', input: {} },
            __activeLoopInbox: { current: [], all: [] },
        } as any;

        await service.sendTaskToAgent(sourceCtx, 'child-agent', { value: 1 }, {
            awaitCompletion: false,
            parentTenantId: 'tenant-a',
            parentTaskId: 'parent-task',
            parentChildToken: 'child-token',
            cache: { enabled: false },
        } as any);
        await service.waitForPendingNotifications();

        expect(handleChildCompleted).not.toHaveBeenCalled();
    });
});
