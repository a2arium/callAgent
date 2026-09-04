import { describe, expect, it, jest } from '@jest/globals';
import { InMemorySessionManager, SessionManager } from '@a2arium/callagent-core/unstable';
import { TurnRequestReconciler } from '../src/turnRequestReconciler.js';

describe('TurnRequestReconciler', () => {
    it('reconstructs a missing initial durable root before publishing its deterministic nudge', async () => {
        const clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const sessions = new SessionManager(new InMemorySessionManager(() => clockMs));
        await sessions.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: {
                meta: {
                    agentId: 'agent-a',
                    initialInput: { caseId: 'case-a' },
                    taskLifecycle: {
                        taskId: 'task-a', rootTaskId: 'task-a', ancestorTaskIds: [], state: 'active',
                    },
                    turnCoordinator: {
                        schemaVersion: 1,
                        nextFence: '0',
                        nextTurnSeq: 0,
                        requestedGeneration: '1',
                        completedGeneration: '0',
                        dispatchIntent: {
                            generation: '1',
                            deliveryKey: 'task-a:turn-request:1',
                            runtimeSurface: 'hatchet',
                            createdAt: '2026-07-19T00:00:00.000Z',
                        },
                    },
                },
            },
        });
        const push = jest.fn(async () => undefined);
        const runNoWait = jest.fn(async () => ({ runId: 'root-run-a' }));
        const reconciler = new TurnRequestReconciler(sessions, { push }, {
            rootTask: { runNoWait } as never,
        });

        await expect(reconciler.scanOnce()).resolves.toBe(1);

        expect(runNoWait).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-a',
            taskId: 'task-a',
            agentId: 'agent-a',
            input: { caseId: 'case-a' },
            idempotencyKey: 'task-a:turn-request:1',
            recoveryGeneration: '1',
            recoveryDeliveryKey: 'task-a:turn-request:1',
            rootRunKey: '8:tenant-a:6:task-a:root:1',
        }), expect.objectContaining({ additionalMetadata: expect.objectContaining({
            operation: 'agent.run.recovery',
            deliveryKey: 'task-a:turn-request:1',
        }) }));
        expect(push).toHaveBeenCalledWith(
            'task-turn-available:8:tenant-a:6:task-a',
            expect.objectContaining({ generation: '1', deliveryKey: 'task-a:turn-request:1' }),
            { key: 'task-a:turn-request:1' },
        );
        await expect(sessions.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(0);
    });

    it('stages an expired claim before publishing its recovery nudge', async () => {
        const clockMs = Date.parse('2026-09-04T12:00:00.000Z');
        const sessions = new SessionManager(new InMemorySessionManager(() => clockMs));
        await sessions.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-expired', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: { meta: {
                agentId: 'agent-a', initialInput: { caseId: 'case-a' },
                taskLifecycle: {
                    taskId: 'task-expired', rootTaskId: 'task-expired', ancestorTaskIds: [], state: 'active',
                },
                turnCoordinator: {
                    schemaVersion: 1, nextFence: '1', nextTurnSeq: 1,
                    requestedGeneration: '1', completedGeneration: '0', runtimeSurface: 'hatchet',
                    active: {
                        claimId: 'claim-expired', fence: '1', ownerId: 'old-worker',
                        requestKey: 'task-expired:start', claimedGeneration: '1', turnSeq: 1,
                        phase: 'executing', runtimeSurface: 'hatchet',
                        acquiredAt: '2026-09-04T11:00:00.000Z',
                        heartbeatAt: '2026-09-04T11:00:00.000Z',
                        expiresAt: '2026-09-04T11:01:00.000Z',
                    },
                },
            } },
        });
        const push = jest.fn(async () => undefined);
        const runNoWait = jest.fn(async () => ({ runId: 'recovered-root' }));
        const reconciler = new TurnRequestReconciler(sessions, { push }, {
            rootTask: { runNoWait } as never,
        });

        await expect(reconciler.scanOnce()).resolves.toBe(1);
        expect(push).toHaveBeenCalledWith(
            expect.stringContaining('task-turn-available:'),
            expect.objectContaining({ generation: '1', deliveryKey: 'task-expired:turn-request:1' }),
            { key: 'task-expired:turn-request:1' },
        );
        const state = (await sessions.load('tenant-a', 'task-expired'))?.snapshot as {
            meta?: { turnCoordinator?: { active?: unknown; dispatchIntent?: { recovery?: { reason?: string } } } };
        };
        expect(state.meta?.turnCoordinator?.active).toBeUndefined();
        expect(state.meta?.turnCoordinator?.dispatchIntent?.recovery?.reason).toBe('lease_expired');
    });
});
