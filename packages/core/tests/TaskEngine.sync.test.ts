import { TaskEngine } from '../src/core/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/core/orchestration/InMemorySessionManager.js';
import { globalA2AService } from '../src/core/orchestration/A2AService.js';
import { jest } from '@jest/globals';

describe('TaskEngine sync completion', () => {
    const tenantId = 'tenant-test';
    const parentTaskId = 'parent-task';

    const buildEngine = () => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        // Access private sessionManager for test setup
        const sessionManager = (engine as any).sessionManager;
        return { engine, sessionManager };
    };

    const setupContext = async (engine: TaskEngine, sessionManager: any) => {
        const taskEntity = { id: parentTaskId, input: {} };
        // Create context using private method
        const ctx = (engine as any).createContext(taskEntity);

        // Ensure session data exists
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'parent-agent' },
                M: { memory: { vars: {} } }
            }
        });

        // Attach orchestration APIs using private method
        await (engine as any).attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            flushMentalState: async () => { } // no-op
        });

        return ctx;
    };

    it('returns object with token when sync child returns a result object (fix for cache hit bug)', async () => {
        const { engine, sessionManager } = buildEngine();
        const ctx = await setupContext(engine, sessionManager);

        const mockResult = {
            status: { state: 'completed' },
            data: { some: 'data' }
        };

        // Spy on globalA2AService.sendTaskToAgent to simulate sync completion
        const sendSpy = jest.spyOn(globalA2AService, 'sendTaskToAgent')
            .mockImplementation(async (params: any) => {
                // Return the result directly to simulate a Sync Completion (like a Cache Hit)
                // The engine will handle calling handleChildCompleted
                return mockResult;
            });


        // Call context API
        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' });

        expect(result).toBeDefined();
        // The fix ensures token is present even if spread failed or A2A returned undefined
        expect(result.token).toBeDefined();
        expect(result).toMatchObject(mockResult);

        sendSpy.mockRestore();
    });

    it('returns object with token when sync child returns undefined (fallback path)', async () => {
        const { engine, sessionManager } = buildEngine();
        const ctx = await setupContext(engine, sessionManager);

        // Spy with input_required scenario where it returns undefined
        const sendSpy = jest.spyOn(globalA2AService, 'sendTaskToAgent')
            .mockImplementation(async (params: any) => {
                const token = params.handle?.token;
                if (token) {
                    await engine.handleChildCompleted({
                        tenantId,
                        parentTaskId,
                        childToken: token,
                        childTaskId: 'child-task-id',
                        result: undefined // Simulate empty result/undefined
                    });
                }
                return undefined;
            });

        const result = await ctx.sendTaskToAgent('child-agent-2', {});

        expect(result).toBeDefined();
        // The fix ensures we return { token } at minimum
        expect(result.token).toBeDefined();

        sendSpy.mockRestore();
    });
});
