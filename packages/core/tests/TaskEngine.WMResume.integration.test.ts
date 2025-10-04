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
                    policy: (M: any, env: any) => {
                        if (env.input?.kind === 'input') {
                            // Verify vars were restored from MentalState
                            if (M.memory.vars.debugString === 'first-turn') {
                                varsRestored = true;
                            }
                            return { kind: 'language', content: `Input received: ${env.input.value}` };
                        }

                        // Initial turn - set vars and ask for input
                        M.memory.vars = { ...M.memory.vars, debugString: 'first-turn' };
                        return { kind: 'ask_user', prompt: 'Provide value' };
                    },

                    execution: async (action: any, ctx: any, M: any) => {
                        if (action.kind === 'ask_user') {
                            const handle = await ctx.requestInput(action.prompt);
                            return { kind: 'ask_user', token: handle.token };
                        }
                        if (action.kind === 'language') {
                            await ctx.reply(action.content);
                            return { kind: 'language', echoed: true };
                        }
                        return { kind: 'internal', done: true };
                    },

                    transition: (env: any, exec: any, M: any) => {
                        if (exec.kind === 'ask_user') {
                            return { kind: 'await_input', token: exec.token };
                        }
                        if (exec.kind === 'language') {
                            return { kind: 'complete' };
                        }
                        return { kind: 'continue' };
                    }
                }
            },
            async handleTask(ctx: any) { return; }
        }, import.meta.url);

        PluginManager.registerAgent(testAgent);

        const entity: TaskEntity = { id: taskId, input: {}, agentId: 'wm-resume-test-agent' };
        const result = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'wm-resume-test-agent' });

        // Find pending input token from snapshot
        const snap = await store.getSessionSnapshot(tenantId, taskId);
        expect(snap).not.toBeNull();
        const pending = ((snap!.snapshot as any)?.pending?.inputs || {}) as Record<string, unknown>;
        const token = Object.keys(pending)[0];
        expect(token).toBeDefined();

        // Auto-resume should restore vars from MentalState
        await engine.resumeInput({ tenantId, taskId, token, input: 42 });

        expect(varsRestored).toBe(true);
    });
});


