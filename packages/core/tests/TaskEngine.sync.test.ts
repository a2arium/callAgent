import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { globalA2AService } from '../src/orchestration/A2AService.js';
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

        // Ensure session data exists with complete mental state structure
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'parent-agent', turn: 0 },
                M: {
                    memory: {
                        vars: {},
                        sensory: { llmState: undefined },
                        longTerm: { semantic: {}, episodic: [], procedural: {} }
                    },
                    worldModel: { explicit: null, implicit: null, simulator: null },
                    goalState: { hierarchy: { roots: [], nodes: {} } },
                    emotion: { valence: 0, arousal: 0.2 },
                    policyParams: { theta: null, stochastic: false },
                    rewardParams: {
                        discountGamma: 0.99,
                        extrinsicWeights: [1],
                        intrinsic: { exploration: 0, curiosity: 0, competence: 0, novelty: 0 }
                    }
                }
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
        // New API returns { handle, token } where result fields are in handle
        expect(result.handle).toBeDefined();
        expect(result.handle.status).toEqual(mockResult.status);
        expect(result.handle.data).toEqual(mockResult.data);

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
