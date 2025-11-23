import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import type { PrismaClient } from '@prisma/client';
import { createAgent } from '../src/index.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';

class PrismaStub {
    agentResultCache = {
        findUnique: async () => null,
        delete: async () => undefined,
        upsert: async () => undefined,
        deleteMany: async () => ({ count: 0 })
    };
}

class MockSessionStoreWithPrisma implements IWorkingMemorySessionStore {
    public prisma: PrismaClient;
    private snapshots = new Map<string, { wmVersion: bigint; snapshot: Record<string, unknown>; agentId: string; updatedAt: string }>();

    constructor() {
        this.prisma = new PrismaStub() as unknown as PrismaClient;
    }

    private key(tenantId: string, sessionId: string) {
        return `${tenantId}:${sessionId}`;
    }

    seed(tenantId: string, sessionId: string, snapshot: Record<string, unknown>, agentId = 'default', wmVersion: bigint = 0n) {
        const updatedAt = new Date().toISOString();
        this.snapshots.set(this.key(tenantId, sessionId), { wmVersion, snapshot, agentId, updatedAt });
    }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        const stored = this.snapshots.get(this.key(tenantId, sessionId));
        return stored ? { wmVersion: stored.wmVersion, snapshot: stored.snapshot, agentId: stored.agentId, updatedAt: stored.updatedAt } : null;
    }

    async writeSnapshotCAS(params: { tenantId: string; sessionId: string; agentId: string; expectedWmVersion: bigint; snapshot: Record<string, unknown>; }): Promise<{ newVersion: bigint }> {
        const k = this.key(params.tenantId, params.sessionId);
        const existing = this.snapshots.get(k);
        if (existing && existing.wmVersion !== params.expectedWmVersion) {
            throw new Error('CAS_MISMATCH');
        }
        const nextVersion = (existing?.wmVersion ?? 0n) + 1n;
        this.snapshots.set(k, {
            wmVersion: nextVersion,
            snapshot: params.snapshot,
            agentId: params.agentId,
            updatedAt: new Date().toISOString()
        });
        return { newVersion: nextVersion };
    }

    async appendEvent(): Promise<{ eventId: string; seq: number }> {
        return { eventId: `${Date.now()}`, seq: 0 };
    }

    async listEventsSince(): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        return [];
    }

    async enqueueOutbox(): Promise<void> {
        return;
    }
}

describe('TaskEngine artifact hydration', () => {
    it('hydrates artifact markers in working memory vars into promise-like handles', async () => {
        const store = new MockSessionStoreWithPrisma();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't-artifact';
        const taskId = 'artifact-hydration-task';
        const agentName = 'artifact-hydration-agent-test';

        store.seed(
            tenantId,
            taskId,
            {
                M: {
                    memory: {
                        vars: {
                            pendingArtifact: {
                                kind: 'artifact',
                                id: 'fake-artifact-id',
                                estimatedSize: 123
                            }
                        }
                    }
                },
                meta: { turn: 0 }
            },
            agentName,
            0n
        );

        const verifyAgent = createAgent({
            manifest: { name: agentName, version: '1.0.0', runMode: 'loop' },
            loop: {
                modules: {
                    policy: () => ({ kind: 'internal', intent: 'verify' }),
                    execution: async (action, ctx) => {
                        if (action.kind === 'internal' && action.intent === 'verify') {
                            const artifact = ctx.vars.get('pendingArtifact');
                            ctx.vars.set('observedKind', artifact?.kind);
                            ctx.vars.set('observedIsPromise', typeof artifact?.then === 'function');
                        }
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'ok', ts: Date.now(), toolId: 'artifact-hydration' }
                        };
                    },
                    transition: () => ({ kind: 'complete' })
                }
            },
            async handleTask() {
                return;
            }
        }, import.meta.url);

        PluginManager.registerAgent(verifyAgent);

        const entity: TaskEntity = { id: taskId, input: {}, agentId: agentName };
        await engine.startTask({ task: entity, isStreaming: false, tenantId, agentId: agentName });

        const snap = await store.getSessionSnapshot(tenantId, taskId);
        expect(snap).not.toBeNull();
        const vars = ((snap!.snapshot as any)?.M?.memory?.vars) || {};
        expect(vars.observedKind).toBe('artifact');
        expect(vars.observedIsPromise).toBe(true);
    });
});


