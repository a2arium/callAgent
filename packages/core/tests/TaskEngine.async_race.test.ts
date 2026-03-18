import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { globalA2AService } from '../src/orchestration/A2AService.js';
import { jest } from '@jest/globals';

describe('TaskEngine Async Persistence Race', () => {
    const tenantId = 'tenant-test';
    const parentTaskId = 'parent-task';

    const buildEngine = () => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const sessionManager = (engine as any).sessionManager;
        return { engine, sessionManager };
    };

    it('should NOT corrupt snapshot if load returns empty during async dispatch', async () => {
        const { engine, sessionManager } = buildEngine();

        // Setup initial valid snapshot (Turn 4); use worldModel (no memory.vars in 3.3.1)
        const initialSnap = {
            meta: { agentId: 'parent-agent', turn: 4 },
            M: { memory: { sensory: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } }, worldModel: { existingVar: 'value' }, goalState: { hierarchy: { nodes: {}, roots: [] } }, emotion: { valence: 0, arousal: 0 }, rewardParams: { extrinsicWeights: [], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 1 }, policyParams: { theta: undefined, stochastic: false } }
        };

        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            expectedWmVersion: BigInt(0),
            snapshot: initialSnap
        });

        // Mock context
        const taskEntity = { id: parentTaskId, input: {} };
        const ctx = (engine as any).createContext(taskEntity);
        // Inject active loop env to trigger writeOnce logic in sendTaskToAgent
        (ctx as any).__activeLoopInbox = { current: [], all: [] };
        (ctx as any).__activeLoopEnv = { pending: {} };
        (ctx as any).tenantId = tenantId;

        // Mock A2AService to be successful
        jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({ token: 'child-token' } as any);

        // Spy on sessionManager.load to return EMPTY object (simulating read failure or race)
        // We only want to fail ONCE (the one inside writeOnce), then succeed to verify correctness
        const realLoad = sessionManager.load.bind(sessionManager);
        let loadCallCount = 0;
        jest.spyOn(sessionManager, 'load').mockImplementation(async (tid: string, sid: string) => {
            loadCallCount++;
            // Return empty for all loads during the sendTaskToAgent call (first ~6 calls)
            // After that, return real data for final verification
            if (loadCallCount <= 10) {
                // Return empty snapshot wrapper (but VALID session object so code doesn't crash immediately)
                // Use version >= 3 so integrity check fires (our fix allows versions < 3 to be minimal)
                return { snapshot: {}, wmVersion: BigInt(5) } as any;
            }
            return realLoad(tid, sid);
        });

        // Initialize orchestration APIs on ctx
        // Initialize orchestration APIs on ctx
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent',
            flushMentalState: async () => { }
        });

        // Execute async dispatch
        // We expect this to FAIL with our new integrity check
        let caughtError: Error | undefined;
        try {
            await (ctx as any).sendTaskToAgent('child', {}, {});
        } catch (e) {
            caughtError = e as Error;
        }

        // VERIFICATION:
        // The fix should PREVENT the save and throw an error.
        expect(caughtError).toBeDefined();
        expect(caughtError?.message).toContain('SNAPSHOT_INTEGRITY_CHECK_FAILED');

        // Check final snapshot state - MUST REMAIN UNCHANGED (valid)
        const finalSnap = await realLoad(tenantId, parentTaskId);
        const snapshot = finalSnap?.snapshot as any;

        console.log('Final Snapshot Meta:', snapshot?.meta);

        expect(snapshot.meta).toBeDefined();
        expect(snapshot.meta.turn).toBe(4);
        expect(snapshot.M).toBeDefined();
        expect((snapshot.M as Record<string, unknown>).worldModel).toBeDefined();
        expect((snapshot.M as Record<string, unknown>).worldModel).toEqual(expect.objectContaining({ existingVar: 'value' }));
    });
});
