import { describe, expect, it, jest } from '@jest/globals';
import { TaskExecutor } from '../src/orchestration/TaskExecutor.js';
import { WorkingMemoryVersionConflictError } from '@a2arium/callagent-types';

const createFakeArtifactPrisma = () => {
    const artifacts = new Map<string, unknown>();
    return {
        agentResultCache: {
            upsert: jest.fn(async (args: any) => {
                artifacts.set(args.create.cacheKey, args.create.result);
                return args.create;
            }),
            findUnique: jest.fn(async (args: any) => {
                const cacheKey = args.where?.tenantId_agentName_cacheKey?.cacheKey;
                if (!artifacts.has(cacheKey)) return null;
                return {
                    id: cacheKey,
                    result: artifacts.get(cacheKey),
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + 60_000),
                };
            }),
            delete: jest.fn(async () => ({})),
        },
    };
};

describe('TaskExecutor snapshot persistence', () => {
    it('sanitizes raw child.completed payloads from merged inboxes before saving snapshots', async () => {
        const rawHtml = `<html>${'task-executor-child-html'.repeat(5000)}</html>`;
        const rawObservation = {
            source: 'child',
            kind: 'child.completed',
            payload: {
                token: 'tok-1',
                result: {
                    ok: true,
                    data: {
                        html: rawHtml,
                        content: rawHtml,
                    },
                },
            },
        };
        let savedSnapshot: Record<string, unknown> | undefined;
        const prisma = createFakeArtifactPrisma();
        const sessionManager = {
            prisma,
            load: jest.fn(async () => ({
                wmVersion: BigInt(3),
                snapshot: {
                    meta: { turn: 1, agentId: 'agent-a' },
                    inbox: {
                        current: [],
                        all: [rawObservation],
                    },
                },
            })),
            saveSnapshot: jest.fn(async (params: { snapshot: Record<string, unknown> }) => {
                savedSnapshot = params.snapshot;
                return { newVersion: BigInt(4) };
            }),
        };

        await (TaskExecutor as any).saveSnapshot({
            sessionManager,
            tenantId: 'tenant-a',
            sessionId: 'parent-1',
            agentId: 'agent-a',
            env: {
                turn: 2,
                pending: { children: {} },
                inbox: {
                    current: [rawObservation],
                    all: [rawObservation],
                },
            },
            M: {},
            mNext: {},
            outcome: { kind: 'complete', result: { ok: true } },
            loopOpts: {},
            ctx: {},
            getSessionStorePrisma: () => prisma,
        });

        const serialized = JSON.stringify(savedSnapshot);
        expect(serialized).not.toContain(rawHtml);
        const inbox = (savedSnapshot as any).inbox;
        const obs = inbox.all.find((entry: any) => entry?.payload?.token === 'tok-1');
        expect(obs?.payload?.result?.data?.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(obs?.payload?.result?.data?.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });

    it('does not resurrect a child terminal that commits while the parent turn is persisting', async () => {
        const token = 'child-race';
        const terminalObservation = {
            source: 'child',
            kind: 'child.completed',
            payload: { token, childTaskId: 'child-task', result: { ok: true } },
            provenance: { ts: 10, turn: 2, id: token, correlationId: token },
        };
        let current: any = {
            wmVersion: BigInt(1),
            agentId: 'parent-agent',
            snapshot: {
                meta: { turn: 1, agentId: 'parent-agent' },
                pending: {
                    children: { [token]: { agentId: 'child-agent' } },
                    tasks: { [token]: { agentId: 'child-agent', childTaskId: 'child-task' } },
                },
                inbox: { current: [], all: [] },
            },
        };
        let attempt = 0;
        const sessionManager = {
            load: jest.fn(async () => current),
            saveSnapshot: jest.fn(async (params: any) => {
                attempt += 1;
                if (attempt === 1) {
                    current = {
                        wmVersion: BigInt(2),
                        agentId: 'parent-agent',
                        snapshot: {
                            ...current.snapshot,
                            pending: {
                                children: {},
                                tasks: {},
                                childTerminals: {
                                    [token]: {
                                        kind: 'completed',
                                        claimedAt: '2026-01-01T00:00:00.000Z',
                                        childTaskId: 'child-task',
                                        agentId: 'child-agent',
                                    },
                                },
                            },
                            inbox: { current: [terminalObservation], all: [terminalObservation] },
                        },
                    };
                    throw new WorkingMemoryVersionConflictError({
                        tenantId: 'tenant-a',
                        sessionId: 'parent-race',
                        expectedWmVersion: '1',
                        actualWmVersion: '2',
                    }, 'CAS_MISMATCH');
                }
                current = {
                    wmVersion: params.expectedWmVersion + BigInt(1),
                    agentId: 'parent-agent',
                    snapshot: params.snapshot,
                };
                return { newVersion: current.wmVersion };
            }),
        };

        await (TaskExecutor as any).saveSnapshot({
            sessionManager,
            tenantId: 'tenant-a',
            sessionId: 'parent-race',
            agentId: 'parent-agent',
            env: {
                turn: 2,
                pending: {
                    children: { [token]: { agentId: 'child-agent' } },
                    tasks: { [token]: { agentId: 'child-agent', childTaskId: 'child-task' } },
                },
                inbox: { current: [], all: [] },
            },
            M: {},
            mNext: {},
            outcome: { kind: 'await_child', token },
            loopOpts: {},
            ctx: {},
            getSessionStorePrisma: () => undefined,
        });

        expect(current.snapshot.pending.children).toEqual({});
        expect(current.snapshot.pending.tasks).toEqual({});
        expect(current.snapshot.pending.childTerminals[token]).toBeDefined();
        expect(current.snapshot.inbox.all).toEqual([
            expect.objectContaining({ kind: 'child.completed', payload: expect.objectContaining({ token }) }),
        ]);
    });

    it('does not resurrect a detached tool or overwrite terminal lifecycle during a stale turn save', async () => {
        const token = 'tool-race';
        let current: any = {
            wmVersion: BigInt(1),
            agentId: 'agent-a',
            snapshot: {
                meta: {
                    turn: 1,
                    agentId: 'agent-a',
                    taskLifecycle: {
                        taskId: 'task-a',
                        rootTaskId: 'task-a',
                        ancestorTaskIds: [],
                        state: 'active',
                    },
                },
                pending: { tools: { [token]: { name: 'slow-tool', args: {} } } },
                inbox: { current: [], all: [] },
            },
        };
        let attempt = 0;
        const sessionManager = {
            load: jest.fn(async () => current),
            saveSnapshot: jest.fn(async (params: any) => {
                attempt += 1;
                if (attempt === 1) {
                    current = {
                        wmVersion: BigInt(2),
                        agentId: 'agent-a',
                        snapshot: {
                            ...current.snapshot,
                            meta: {
                                ...current.snapshot.meta,
                                taskLifecycle: {
                                    ...current.snapshot.meta.taskLifecycle,
                                    state: 'detached',
                                    reason: 'child_timeout',
                                    changedAt: '2026-07-16T12:00:00.000Z',
                                },
                            },
                            pending: {
                                tools: {},
                                toolTerminals: {
                                    [token]: {
                                        kind: 'detached',
                                        claimedAt: '2026-07-16T12:00:00.000Z',
                                        reason: 'child_timeout',
                                    },
                                },
                            },
                        },
                    };
                    throw new WorkingMemoryVersionConflictError({
                        tenantId: 'tenant-a',
                        sessionId: 'task-a',
                        expectedWmVersion: '1',
                        actualWmVersion: '2',
                    }, 'CAS_MISMATCH');
                }
                current = {
                    wmVersion: params.expectedWmVersion + BigInt(1),
                    agentId: 'agent-a',
                    snapshot: params.snapshot,
                };
                return { newVersion: current.wmVersion };
            }),
        };

        await (TaskExecutor as any).saveSnapshot({
            sessionManager,
            tenantId: 'tenant-a',
            sessionId: 'task-a',
            agentId: 'agent-a',
            env: {
                turn: 2,
                pending: { tools: { [token]: { name: 'slow-tool', args: {} } } },
                inbox: { current: [], all: [] },
            },
            M: {},
            mNext: {},
            outcome: { kind: 'await_tool', token },
            loopOpts: {},
            ctx: {},
            getSessionStorePrisma: () => undefined,
        });

        expect(current.snapshot.meta.taskLifecycle).toMatchObject({
            state: 'detached',
            reason: 'child_timeout',
        });
        expect(current.snapshot.pending.tools).toEqual({});
        expect(current.snapshot.pending.toolTerminals[token]).toMatchObject({ kind: 'detached' });
    });
});
