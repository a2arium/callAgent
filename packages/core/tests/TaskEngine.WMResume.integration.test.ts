import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import { registerHandler } from '../src/core/orchestration/HandlerRegistry.js';

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
        if (existing && existing.wmVersion !== params.expectedWmVersion) {
            throw new Error('CAS_MISMATCH');
        }
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

    async listEventsSince(): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        return [];
    }

    async enqueueOutbox(): Promise<void> { /* no-op */ }
}

describe('TaskEngine - requestInput resume restores WM vars', () => {
    it('restores ctx.vars in durable handler after resumeInput', async () => {
        const store = new MockSessionStore();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't';
        const taskId = 'task-1';

        // Register durable handlers
        registerHandler('handleTask', async (ctx: any) => {
            ctx.tenantId = tenantId;
            ctx.vars.debugString = 'first-turn';
            await ctx.requestInput('Provide value', { onProvided: 'onProvided' });
        });
        registerHandler('onProvided', async (ctx: any, ev: { input: unknown }) => {
            if (ctx.vars.debugString !== 'first-turn') {
                throw new Error('vars not restored');
            }
            return ev.input;
        });

        const entity: TaskEntity = { id: taskId, input: {} };
        await engine.startTask({ task: entity, isStreaming: true });

        // Find pending input token from snapshot
        const snap = await store.getSessionSnapshot(tenantId, taskId);
        expect(snap).not.toBeNull();
        const pending = ((snap!.snapshot as any)?.pending?.inputs || {}) as Record<string, { handlerName: string }>;
        const token = Object.keys(pending)[0];
        expect(token).toBeDefined();

        await engine.resumeInput({ tenantId, taskId, token, input: 42 });
    });
});


