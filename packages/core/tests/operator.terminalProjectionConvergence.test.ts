import { describe, expect, it, jest } from '@jest/globals';
import { OperatorProjectionRepository } from '../src/operator/semanticProjection.js';

describe('durable terminal projection convergence', () => {
    it('repairs completed ok:false tasks and supersedes orphan running attempts', async () => {
        const prisma = {
            agentRun: { upsert: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
            agentRunEdge: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 2 })),
            },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);
        const snapshot = {
            meta: {
                taskLifecycle: {
                    taskId: 'task-1', rootTaskId: 'task-1', ancestorTaskIds: [], state: 'completed',
                },
                taskTerminal: {
                    taskId: 'task-1',
                    state: 'completed',
                    claimedAt: '2026-07-20T02:50:31.490Z',
                    deliveryKey: 'task-1:terminal:completed',
                    status: {
                        state: 'completed',
                        timestamp: '2026-07-20T02:50:31.490Z',
                        metadata: { result: { ok: false, error: { code: 'FETCH_FAILED' } } },
                    },
                    turnClaim: {
                        attemptKey: 'claim:claim-1', claimId: 'claim-1', fence: '1',
                        generation: '1', turnSeq: 1,
                    },
                },
            },
        };

        await expect(projection.reconcileDurableTerminal({
            tenantId: 'tenant-a', taskId: 'task-1', snapshot, agentId: 'agent-a',
        })).resolves.toBe(true);

        expect(prisma.agentRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ status: 'completed', outputState: 'available' }),
        }));
        expect(prisma.turnRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                attemptKey: 'claim:claim-1', status: 'completed', authoritativeTerminal: true,
            }),
            update: expect.objectContaining({ status: 'completed', authoritativeTerminal: true }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-a', taskId: 'task-1',
                attemptKey: { not: 'claim:claim-1' }, status: 'running',
            },
            data: {
                status: 'superseded', disposition: 'superseded',
                completedAt: new Date('2026-07-20T02:50:31.490Z'), authoritativeTerminal: false,
            },
        });
    });

    it('reconciles historical terminal snapshots in restart-safe keyset batches', async () => {
        const terminalSnapshot = (taskId: string) => ({
            meta: {
                taskLifecycle: { taskId, rootTaskId: taskId, ancestorTaskIds: [], state: 'completed' },
                taskTerminal: {
                    taskId,
                    state: 'completed',
                    claimedAt: '2026-07-20T02:50:31.490Z',
                    deliveryKey: `${taskId}:terminal:completed`,
                    status: { state: 'completed', timestamp: '2026-07-20T02:50:31.490Z' },
                    turnClaim: { claimId: `claim-${taskId}`, fence: '1', generation: '1', turnSeq: 1 },
                },
            },
        });
        const findMany = jest
            .fn<(...args: never[]) => Promise<unknown[]>>()
            .mockResolvedValueOnce([
                { tenantId: 'a', sessionId: '1', agentId: 'agent', snapshot: terminalSnapshot('1') },
                { tenantId: 'a', sessionId: '2', agentId: 'agent', snapshot: terminalSnapshot('2') },
            ])
            .mockResolvedValueOnce([
                { tenantId: 'b', sessionId: '3', agentId: 'agent', snapshot: terminalSnapshot('3') },
            ]);
        const prisma = {
            wMSession: { findMany },
            agentRun: { upsert: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
            agentRunEdge: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            runEffect: {},
        };

        const summary = await new OperatorProjectionRepository(prisma as never)
            .reconcileAllDurableTerminals({ batchSize: 2 });

        expect(summary).toEqual({ scanned: 3, reconciled: 3, batches: 2 });
        expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: {
                AND: [
                    expect.objectContaining({ OR: expect.any(Array) }),
                    {
                        OR: [
                            { tenantId: { gt: 'a' } },
                            { tenantId: 'a', sessionId: { gt: '2' } },
                        ],
                    },
                ],
            },
        }));
        expect(prisma.agentRun.upsert).toHaveBeenCalledTimes(3);
    });

    it('repairs legacy terminal tasks without inventing a missing claim', async () => {
        const prisma = {
            agentRun: { upsert: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
            agentRunEdge: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 2 })) },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await expect(projection.reconcileDurableTerminal({
            tenantId: 'tenant-a',
            taskId: 'legacy-task',
            agentId: 'legacy-agent',
            snapshot: {
                meta: {
                    taskTerminal: {
                        taskId: 'legacy-task',
                        state: 'completed',
                        claimedAt: '2026-07-20T02:50:31.490Z',
                        deliveryKey: 'legacy-task:terminal:completed',
                        status: { state: 'completed', timestamp: '2026-07-20T02:50:31.490Z' },
                    },
                },
            },
        })).resolves.toBe(true);

        expect(prisma.agentRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ status: 'completed' }),
        }));
        expect(prisma.turnRun.upsert).not.toHaveBeenCalled();
        expect(prisma.turnRun.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: {
                tenantId: 'tenant-a', taskId: 'legacy-task',
                authoritativeTerminal: true, status: 'running',
            },
            data: expect.objectContaining({ status: 'completed' }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: {
                tenantId: 'tenant-a', taskId: 'legacy-task',
                authoritativeTerminal: false, status: 'running',
            },
            data: expect.objectContaining({ status: 'superseded' }),
        }));
    });

    it('repairs detached lifecycle snapshots as canceled without inventing a turn', async () => {
        const prisma = {
            agentRun: { upsert: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
            agentRunEdge: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await expect(projection.reconcileDurableTerminal({
            tenantId: 'tenant-a', taskId: 'child-task', agentId: 'fetch-html',
            snapshot: {
                meta: {
                    taskLifecycle: {
                        taskId: 'child-task', rootTaskId: 'root-task', parentTaskId: 'root-task',
                        ancestorTaskIds: ['root-task'], state: 'detached',
                        changedAt: '2026-07-22T10:00:00.000Z', reason: 'child_timeout',
                    },
                },
            },
        })).resolves.toBe(true);

        expect(prisma.agentRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ status: 'canceled', cancelReason: 'child_timeout' }),
        }));
        expect(prisma.turnRun.upsert).not.toHaveBeenCalled();
    });

    it('converges an authoritative attempt finish without waiting for task.completed', async () => {
        const terminalAt = new Date('2026-07-22T12:00:00.000Z');
        const prisma = {
            agentRun: {
                findMany: jest.fn(async () => [{
                    tenantId: 'tenant-a', taskId: 'child-task', rootTaskId: 'root-task',
                    scope: 'child', status: 'running', updatedAt: terminalAt,
                }]),
                upsert: jest.fn(async () => ({})),
            },
            agentRunEdge: { updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await projection.projectEvent({
            tenantId: 'tenant-a',
            sessionId: 'child-task',
            type: 'turn.attempt_finished',
            createdAt: terminalAt,
            payload: {
                taskId: 'child-task',
                attemptKey: 'claim:claim-1',
                claimId: 'claim-1',
                turnSeq: 1,
                disposition: 'executed',
                status: 'completed',
                authoritativeTerminal: true,
            },
        });

        expect(prisma.agentRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ status: 'completed', terminalAt }),
        }));
        expect(prisma.turnRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                attemptKey: 'claim:claim-1', status: 'completed', authoritativeTerminal: true,
            }),
            update: expect.objectContaining({ status: 'completed', authoritativeTerminal: true }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenLastCalledWith({
            where: {
                tenantId: 'tenant-a', taskId: 'child-task',
                attemptKey: { not: 'claim:claim-1' }, status: 'running',
            },
            data: {
                status: 'superseded', disposition: 'superseded',
                completedAt: terminalAt, authoritativeTerminal: false,
            },
        });
    });

    it('does not converge sibling attempts for a non-authoritative finish', async () => {
        const prisma = {
            agentRun: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({})) },
            agentRunEdge: {},
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await projection.projectEvent({
            tenantId: 'tenant-a', sessionId: 'task-1', type: 'turn.attempt_finished',
            payload: {
                taskId: 'task-1', attemptKey: 'attempt-2', disposition: 'superseded', status: 'superseded',
            },
        });

        expect(prisma.agentRun.upsert).not.toHaveBeenCalled();
        expect(prisma.turnRun.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.turnRun.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-a', taskId: 'task-1', attemptKey: 'attempt-2',
                authoritativeTerminal: false,
                status: { notIn: ['completed', 'failed', 'canceled'] },
            },
            data: { status: 'completed' },
        });
    });

    it('cleans running attempts for terminal task events without claim metadata', async () => {
        const terminalAt = new Date('2026-07-22T12:05:00.000Z');
        const prisma = {
            agentRun: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({})) },
            agentRunEdge: { updateMany: jest.fn(async () => ({ count: 0 })) },
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
            runEffect: {},
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await projection.projectEvent({
            tenantId: 'tenant-a', sessionId: 'legacy-task', type: 'task.completed',
            createdAt: terminalAt, payload: { taskId: 'legacy-task' },
        });

        expect(prisma.turnRun.upsert).not.toHaveBeenCalled();
        expect(prisma.turnRun.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({
                taskId: 'legacy-task', authoritativeTerminal: true, status: 'running',
            }),
            data: expect.objectContaining({ status: 'completed' }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                taskId: 'legacy-task', authoritativeTerminal: false, status: 'running',
            }),
            data: expect.objectContaining({ status: 'superseded' }),
        }));
    });

    it('preserves authoritative ownership and reconverges after a stale graph write', async () => {
        const terminalAt = new Date('2026-07-22T12:00:00.000Z');
        const persistedTerminal = {
            tenantId: 'tenant-a', taskId: 'task-1', rootTaskId: 'task-1',
            scope: 'root', status: 'completed', terminalAt, updatedAt: terminalAt,
        };
        const prisma = {
            agentRun: {
                findMany: jest.fn(async ({ where }: { where: { taskId?: string | { in: string[] } } }) =>
                    typeof where.taskId === 'object' ? [persistedTerminal] : [persistedTerminal]),
                upsert: jest.fn(async () => ({})),
            },
            agentRunEdge: { upsert: jest.fn(async () => ({})) },
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
            runEffect: { upsert: jest.fn(async () => ({})) },
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await projection.projectGraph({
            schemaVersion: 3,
            tenantId: 'tenant-a',
            taskId: 'task-1',
            root: {
                id: 'task-1', kind: 'agent', tenantId: 'tenant-a', rootTaskId: 'task-1',
                taskId: 'task-1', status: 'running', severity: 'info',
            },
            nodes: [{
                id: 'task-1', kind: 'agent', tenantId: 'tenant-a', rootTaskId: 'task-1',
                taskId: 'task-1', status: 'running', severity: 'info',
            }],
            edges: [],
            turns: [{
                id: 'turn:task-1:1', rootTaskId: 'task-1', taskId: 'task-1',
                status: 'running', operation: 'turn.segment', turnSeq: 1, severity: 'info',
                attempts: [{
                    id: 'claim-row', rootTaskId: 'task-1', taskId: 'task-1',
                    status: 'running', operation: 'turn.segment', turnSeq: 1,
                    attemptKey: 'claim:claim-1', claimId: 'claim-1', disposition: 'executed',
                }],
            }],
            memoryOps: [], effects: [], events: [], debug: { driverRuns: [] },
        });

        expect(prisma.turnRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ authoritativeTerminal: false }),
            update: expect.not.objectContaining({ authoritativeTerminal: false }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                taskId: 'task-1', authoritativeTerminal: true, status: 'running',
            }),
            data: expect.objectContaining({ status: 'completed' }),
        }));
        expect(prisma.turnRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                taskId: 'task-1', authoritativeTerminal: false, status: 'running',
            }),
            data: expect.objectContaining({ status: 'superseded' }),
        }));
    });

    it('does not clean running attempts when persisted task state is nonterminal', async () => {
        const prisma = {
            agentRun: {
                findMany: jest.fn(async () => []),
                upsert: jest.fn(async () => ({})),
            },
            agentRunEdge: { upsert: jest.fn(async () => ({})) },
            turnRun: {
                upsert: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            runEffect: { upsert: jest.fn(async () => ({})) },
        };
        const projection = new OperatorProjectionRepository(prisma as never);

        await projection.projectGraph({
            schemaVersion: 3,
            tenantId: 'tenant-a',
            taskId: 'task-1',
            root: {
                id: 'task-1', kind: 'agent', tenantId: 'tenant-a', rootTaskId: 'task-1',
                taskId: 'task-1', status: 'running', severity: 'info',
            },
            nodes: [{
                id: 'task-1', kind: 'agent', tenantId: 'tenant-a', rootTaskId: 'task-1',
                taskId: 'task-1', status: 'running', severity: 'info',
            }],
            edges: [], turns: [], memoryOps: [], effects: [], events: [], debug: { driverRuns: [] },
        });

        expect(prisma.turnRun.updateMany).not.toHaveBeenCalled();
    });
});
