import { TaskEngine } from '../src/core/orchestration/taskEngine.js';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';

describe('External events registry integration', () => {
    it('registers and consumes an external event token and invokes handler', async () => {
        const store = new WorkingMemorySessionStore();
        const engine = new TaskEngine({ sessionStore: store });

        const tenantId = 't';
        const taskId = 'task-evt-1';
        // start a task to create snapshot/session
        await (engine as any).sessionManager.saveSnapshot({ tenantId, sessionId: taskId, agentId: 'agent', expectedWmVersion: BigInt(0), snapshot: { M: { memory: { vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } }, sensory: {} }, worldModel: {}, goalState: { hierarchy: { nodes: {}, roots: [] } }, emotion: { valence: 0, arousal: 0 }, rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 }, policyParams: { theta: null, stochastic: false } } } });

        // Add a pending external event manually
        // Reload snapshot right before writing to avoid CAS_MISMATCH
        let snap = await (engine as any).sessionManager.load(tenantId, taskId);
        const base = (snap?.snapshot as any) || {};
        base.pending = base.pending || {};
        base.pending.events = { 'tok-1': { type: 'test', handlers: { occurred: 'onOccurred' } } };
        // Reload to get latest version before writing
        snap = await (engine as any).sessionManager.load(tenantId, taskId);
        await (engine as any).sessionManager.saveSnapshot({ tenantId, sessionId: taskId, agentId: 'agent', expectedWmVersion: snap?.wmVersion ?? BigInt(0), snapshot: base });

        // Mock handler invoker
        const called: any[] = [];
        (engine as any).handlerInvoker = { invoke: async ({ handlerName, input }: any) => { called.push({ handlerName, input }); } };

        await engine.handleExternalEventOccurred({ tenantId, taskId, token: 'tok-1', payload: { ok: true } });
        expect(called.length).toBe(1);
        expect(called[0].handlerName).toBe('onOccurred');
        expect(called[0].input).toEqual({ ok: true });
    });
});


