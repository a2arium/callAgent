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
        expect(prisma.turnRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'tenant-a', taskId: 'legacy-task', status: 'running' },
        }));
    });
});
