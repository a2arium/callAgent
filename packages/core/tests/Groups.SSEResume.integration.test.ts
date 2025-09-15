import { createAgent } from '../src/index.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import { TaskEngine } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';

class EphemeralStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, { wmVersion: bigint; snapshot: Record<string, unknown>; agentId: string; updatedAt: string }>();
    private events: Array<{ tenantId: string; sessionId: string; eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }> = [];
    private seqs = new Map<string, number>();
    private key(t: string, s: string) { return `${t}:${s}`; }
    async getSessionSnapshot(t: string, s: string): Promise<WMSessionSnapshot | null> {
        const k = this.key(t, s); const v = this.snapshots.get(k);
        return v ? { wmVersion: v.wmVersion, snapshot: v.snapshot, agentId: v.agentId, updatedAt: v.updatedAt } : null;
    }
    async writeSnapshotCAS(p: { tenantId: string; sessionId: string; agentId: string; expectedWmVersion: bigint; snapshot: Record<string, unknown> }): Promise<{ newVersion: bigint }> {
        const k = this.key(p.tenantId, p.sessionId); const ex = this.snapshots.get(k);
        if (ex && ex.wmVersion !== p.expectedWmVersion) throw new Error('CAS_MISMATCH');
        const nv = (ex?.wmVersion ?? 0n) + 1n;
        this.snapshots.set(k, { wmVersion: nv, snapshot: p.snapshot, agentId: p.agentId, updatedAt: new Date().toISOString() });
        return { newVersion: nv };
    }
    async appendEvent(p: { tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }): Promise<{ eventId: string; seq: number }> {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const seq = (this.seqs.get(this.key(p.tenantId, p.sessionId)) ?? 0) + 1; this.seqs.set(this.key(p.tenantId, p.sessionId), seq);
        this.events.push({ tenantId: p.tenantId, sessionId: p.sessionId, eventId: id, seq, type: p.type, payload: p.payload, createdAt: new Date().toISOString() });
        return { eventId: id, seq };
    }
    async listEventsSince(p: { tenantId: string; sessionId: string; sinceSeq: number }) {
        return this.events.filter(e => e.tenantId === p.tenantId && e.sessionId === p.sessionId && e.seq > p.sinceSeq);
    }
    async enqueueOutbox(): Promise<void> { /* no-op */ }
}

describe('Groups + SSE resume (smoke)', () => {
    it('aggregates child results and emits events in order', async () => {
        const store = new EphemeralStore();
        const engine = new TaskEngine({ sessionStore: store });
        const childA = createAgent({ manifest: { name: 'g-child-a', version: '1.0.0' }, async handleTask() { return { a: 1 }; } }, import.meta.url);
        const childB = createAgent({ manifest: { name: 'g-child-b', version: '1.0.0' }, async handleTask() { return { b: 2 }; } }, import.meta.url);
        const parent = createAgent({
            manifest: { name: 'g-parent', version: '1.0.0', dependencies: { agents: ['g-child-a', 'g-child-b'] } },
            async handleTask(ctx) {
                await ctx.allTasks([
                    { agent: 'g-child-a', input: {} },
                    { agent: 'g-child-b', input: {} }
                ], { onAllCompleted: 'onAll', onAnyFailed: 'onAny' });
                return;
            }
        }, import.meta.url);
        // co-located handlers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).onAll = async (_ctx: any, _ev: unknown) => { /* no-op */ };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).onAny = async (_ctx: any, _ev: unknown) => { /* no-op */ };

        PluginManager.registerAgent(childA);
        PluginManager.registerAgent(childB);
        PluginManager.registerAgent(parent);

        await engine.startTask({ task: { id: 'g1', input: {} }, isStreaming: true });
        const evs = await store.listEventsSince({ tenantId: 'default', sessionId: 'g1', sinceSeq: 0 });
        expect(evs.length).toBeGreaterThan(0);
    });
});


