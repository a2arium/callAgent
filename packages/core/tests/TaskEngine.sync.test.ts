import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { globalA2AService } from '../src/orchestration/A2AService.js';
import { jest } from '@jest/globals';
import type { TaskContext } from '../src/shared/types/index.js';

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
        const ctx: TaskContext = (engine as any).createContext(taskEntity);

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
                        sensory: {},
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

        // Attach orchestration APIs using private method (via apiBinder)
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, {
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
        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }) as any;

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
                // Return undefined to simulate async start (input_required or just started)
                return undefined;
            });

        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }) as any;

        expect(result).toBeDefined();
        expect(result.token).toBeDefined();
        // Handle should not be empty, but should not have status/data from result
        expect(result.handle).toBeDefined();
        // Since result was undefined, these properties wouldn't be assigned
        expect((result.handle as any).status).toBeUndefined();
        expect((result.handle as any).data).toBeUndefined();

        sendSpy.mockRestore();
    });

    it('injects flattened child result into active loop inbox (Payload Consistency Fix)', async () => {
        const { engine, sessionManager } = buildEngine();
        const ctx = await setupContext(engine, sessionManager);

        // Mock __activeLoopInbox on context
        const mockInbox: any = { current: [], all: [] };
        (ctx as any).__activeLoopInbox = mockInbox;
        (ctx as any).__activeLoopEnv = { turn: 5 };

        // Mock a TaskEntity result (wrapped)
        const mockChildTaskEntity = {
            id: 'child-task-123',
            status: {
                state: 'completed',
                timestamp: 123456,
                metadata: {
                    result: { data: 'actual-result' }, // standard result wrapper
                    timings: { start: 1, end: 2 }
                }
            }
        };

        const sendSpy = jest.spyOn(globalA2AService, 'sendTaskToAgent')
            .mockImplementation(async (params: any) => {
                // Return the TaskEntity object
                return mockChildTaskEntity;
            });

        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }, { awaitCompletion: false }) as any;

        expect(result.token).toBeDefined();

        // Verify inbox injection
        expect(mockInbox.current.length).toBe(1);
        const obs = mockInbox.current[0];

        // CHECK PAYLOAD CONSISTENCY FIX
        // Should have unnested result, id, and executionMetadata at top level of payload
        expect(obs.source).toBe('child');
        expect(obs.kind).toBe('child.completed');
        expect(obs.payload).toBeDefined();

        // 1. Flattened ID
        expect(obs.payload.childTaskId).toBe('child-task-123');

        // 2. Extracted Result (should NOT be undefined, should be { data: 'actual-result' })
        expect(obs.payload.result).toEqual({ data: 'actual-result' });

        // 3. Execution Metadata (should be populated)
        expect(obs.payload.executionMetadata).toBeDefined();
        expect(obs.payload.executionMetadata?.timings).toEqual({ start: 1, end: 2 });

        sendSpy.mockRestore();
    });
});
