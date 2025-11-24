import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import { registerHandler, unregisterHandler, invokeHandler } from '../src/core/orchestration/HandlerRegistry.js';

// Helper to clear all handlers (for test cleanup)
function clearHandlers() {
    // Note: HandlerRegistry doesn't expose a clearHandlers function
    // We'll unregister known handlers in beforeEach
    try {
        unregisterHandler('handleTask');
        unregisterHandler('onProvided');
    } catch {
        // Ignore if handlers don't exist
    }
}

class MockSessionStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, { wmVersion: bigint; snapshot: Record<string, unknown>; agentId: string; updatedAt: string }>();
    private seqs = new Map<string, number>();
    private key(tenantId: string, sessionId: string) { return `${tenantId}:${sessionId}`; }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        const k = this.key(tenantId, sessionId);
        const s = this.snapshots.get(k);
        return s ? { wmVersion: s.wmVersion, snapshot: s.snapshot, agentId: s.agentId, updatedAt: s.updatedAt } : null;
    }
    async writeSnapshotCAS(params: { tenantId: string; sessionId: string; agentId: string; expectedWmVersion: bigint; snapshot: Record<string, unknown>; }): Promise<{ newVersion: bigint }> {
        const k = this.key(params.tenantId, params.sessionId);
        const existing = this.snapshots.get(k);
        if (existing && existing.wmVersion !== params.expectedWmVersion) throw new Error('CAS_MISMATCH');
        const nextVer = (existing?.wmVersion ?? 0n) + 1n;
        this.snapshots.set(k, { wmVersion: nextVer, snapshot: params.snapshot, agentId: params.agentId, updatedAt: new Date().toISOString() });
        return { newVersion: nextVer };
    }
    async appendEvent(): Promise<{ eventId: string; seq: number }> {
        const id = `${Date.now()}`;
        const nextSeq = (this.seqs.get(id) ?? 0) + 1;
        this.seqs.set(id, nextSeq);
        return { eventId: id, seq: nextSeq };
    }
    async listEventsSince(): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> { return []; }
    async enqueueOutbox(): Promise<void> { /* no-op */ }
}

describe('MentalState persistence and resume', () => {
    beforeEach(() => { clearHandlers(); });

    it('persists M with vars and goals on await_input and restores on resume', async () => {
        const store = new MockSessionStore();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't';
        const taskId = 'task-ms-1';

        registerHandler('handleTask', async (ctx: any) => {
            ctx.tenantId = tenantId;
            (ctx as any).vars.foo = 'bar';
            const gid = await (ctx as any).addGoal({ title: 'Test Goal', priority: 1 });
            expect(gid).toBeDefined();
            await ctx.requestInput('Provide value', { onProvided: 'onProvided' });
        });
        registerHandler('onProvided', async (ctx: any, ev: { input: unknown }) => {
            // vars should be restored from MentalState
            expect((ctx as any).vars.foo).toBe('bar');
            return ev.input;
        });

        const entity: TaskEntity = { id: taskId, input: {} };
        await engine.startTask({ task: entity, isStreaming: true });

        // Inspect snapshot contains M with vars and goal
        const snap1 = await store.getSessionSnapshot(tenantId, taskId);
        expect(snap1).not.toBeNull();
        const M1 = (snap1!.snapshot as any).M;
        expect(M1).toBeDefined();
        expect(M1.memory?.vars?.foo).toBe('bar');
        const goals = M1.goalState?.hierarchy?.nodes || {};
        expect(Object.keys(goals).length).toBeGreaterThan(0);

        // Resume
        const pend = ((snap1!.snapshot as any)?.pending?.inputs || {}) as Record<string, { handlerName: string }>;
        const token = Object.keys(pend)[0];
        await engine.resumeInput({ tenantId, taskId, token, input: 123 });
    });
});

describe('MentalState LLM mapping on final save (non-streaming)', () => {
    beforeEach(() => { clearHandlers(); });

    it('stores llm exportState under M.memory.sensory.llmState', async () => {
        const store = new MockSessionStore();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't';
        const taskId = 'task-ms-llm-1';

        registerHandler('handleTask', async (ctx: any) => {
            ctx.tenantId = tenantId;
            (ctx as any).llm = { exportState: () => ({ foo: 1 }) };
            (ctx as any).vars.x = 1;
            // do not await; complete turn
        });

        const entity: TaskEntity = { id: taskId, input: {} };
        const result = await engine.startTask({ task: entity, isStreaming: false });
        expect(result).toBeDefined();
        const snap = await store.getSessionSnapshot(tenantId, taskId);
        const M = (snap!.snapshot as any).M;
        expect(M).toBeDefined();
        expect(M.memory?.sensory?.llmState).toBeDefined();
    });
});


