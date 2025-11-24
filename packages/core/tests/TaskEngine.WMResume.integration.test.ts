import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import { createAgent } from '../src/index.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';

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

describe('TaskEngine - Auto-Resume restores WM vars', () => {
    it('restores ctx.vars from MentalState after auto-resume', async () => {
        const store = new MockSessionStore();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't';
        const taskId = 'task-1';
        let varsRestored = false;

        // Create loop-first agent with auto-resume
        const testAgent = createAgent({
            manifest: { name: 'wm-resume-test-agent', version: '1.0.0', runMode: 'loop' },
            loop: {
                modules: {
                    policy: () => ({ kind: 'ask_user', prompt: 'Prompt' }),
                    execution: async (action: any, ctx: any, M: any) => {
                        if (action.kind === 'ask_user') {
                            const handle = await ctx.requestInput(action.prompt);
                            return { action: { kind: 'ask_user', token: handle.token }, result: { status: 'ok', ts: Date.now(), toolId: 'wm-resume-test', data: { prompt: action.prompt }, correlationId: handle.token } };
                        }
                        return { action: { kind: 'internal', done: true }, result: { status: 'ok', ts: Date.now(), toolId: 'wm-resume-test' } };
                    },

                    transition: (env: any, exec: any, M: any) => {
                        const action = exec?.action || exec;
                        if (action.kind === 'ask_user') {
                            return { kind: 'await_input', token: action.token };
                        }
                        if (action.kind === 'language') {
                            return { kind: 'complete' };
                        }
                        return { kind: 'continue', observations: [] };
                    }
                }
            },
            async handleTask(ctx: any) { return; }
        }, import.meta.url);

        PluginManager.registerAgent(testAgent);

        const entity: TaskEntity = { id: taskId, input: {}, agentId: 'wm-resume-test-agent' };
        await engine.startTask({ task: entity, isStreaming: false, tenantId, agentId: 'wm-resume-test-agent' });

        // Find pending input token from snapshot
        const snap = await store.getSessionSnapshot(tenantId, taskId);
        expect(snap).not.toBeNull();
        const pending = ((snap!.snapshot as any)?.pending?.inputs || {}) as Record<string, unknown>;
        const token = Object.keys(pending)[0];
        expect(token).toBeDefined();

        // Set vars in MentalState before resuming
        const initialVars = { testVar: 'initial-value', preservedVar: 'should-be-preserved' };
        const base = (snap!.snapshot as any) || {};
        base.M = base.M || {};
        base.M.memory = base.M.memory || {};
        base.M.memory.vars = { ...base.M.memory.vars, ...initialVars };
        await store.writeSnapshotCAS({ tenantId, sessionId: taskId, agentId: 'wm-resume-test-agent', expectedWmVersion: snap!.wmVersion, snapshot: base });

        // Auto-resume should restore vars from MentalState
        // The test verifies that vars set in MentalState are available after resume
        // We check by verifying the snapshot after resume still has the vars
        await engine.resumeInput({ tenantId, taskId, token, input: 42 });

        // Verify vars are still in MentalState after resume (they should be restored)
        const snapAfter = await store.getSessionSnapshot(tenantId, taskId);
        const varsAfter = (snapAfter!.snapshot as any)?.M?.memory?.vars || {};
        if (varsAfter.testVar === 'initial-value' && varsAfter.preservedVar === 'should-be-preserved') {
            varsRestored = true;
        }

        expect(varsRestored).toBe(true);
    });
});


