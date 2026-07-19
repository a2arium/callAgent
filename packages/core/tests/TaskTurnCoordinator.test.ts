import { describe, expect, it, jest } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import {
    readTaskTurnCoordinator,
    markTaskTurnDispatchEnqueued,
    releaseTaskTurn,
    requestTaskTurn,
    renewTaskTurnClaim,
} from '../src/orchestration/TaskTurnCoordinator.js';
import { registerTaskEffect } from '../src/orchestration/TaskEffectRegistration.js';
import { runWithSegmentIdempotencyKey } from '../src/runtime/segmentProcessedKeys.js';

async function seededSession() {
    const session = new SessionManager(new InMemorySessionManager());
    await session.saveSnapshot({
        tenantId: 'tenant-a',
        sessionId: 'task-a',
        agentId: 'agent-a',
        expectedWmVersion: 0n,
        snapshot: {
            meta: {
                agentId: 'agent-a',
                taskLifecycle: {
                    taskId: 'task-a',
                    rootTaskId: 'task-a',
                    ancestorTaskIds: [],
                    state: 'active',
                },
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '0',
                    completedGeneration: '0',
                },
            },
        },
    });
    return session;
}

describe('TaskTurnCoordinator', () => {
    it.each([
        { nextFence: '01' },
        { requestedGeneration: '-1' },
        { completedGeneration: '2', requestedGeneration: '1' },
        { schemaVersion: 2 },
    ])('rejects malformed coordinator state %#', (override) => {
        const snapshot = {
            meta: {
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '1',
                    completedGeneration: '0',
                    ...override,
                },
            },
        };
        expect(() => readTaskTurnCoordinator(snapshot, {
            tenantId: 'tenant-a', taskId: 'task-a',
        })).toThrow(expect.objectContaining({ code: 'TASK_TURN_COORDINATOR_INVALID' }));
    });

    it.each([
        {
            nextFence: '2', nextTurnSeq: 1,
            active: {
                claimId: 'claim-a', fence: '1', ownerId: 'worker-a', requestKey: 'wake-a',
                claimedGeneration: '1', turnSeq: 1, phase: 'executing', runtimeSurface: 'hatchet',
                acquiredAt: '2026-07-19T00:00:00.000Z', heartbeatAt: '2026-07-19T00:00:00.000Z',
                expiresAt: '2026-07-19T00:02:00.000Z',
            },
        },
        {
            nextFence: '1', nextTurnSeq: 2,
            active: {
                claimId: 'claim-a', fence: '1', ownerId: 'worker-a', requestKey: 'wake-a',
                claimedGeneration: '1', turnSeq: 1, phase: 'executing', runtimeSurface: 'hatchet',
                acquiredAt: '2026-07-19T00:00:00.000Z', heartbeatAt: '2026-07-19T00:00:00.000Z',
                expiresAt: '2026-07-19T00:02:00.000Z',
            },
        },
        {
            dispatchIntent: {
                generation: '1', deliveryKey: 'wake-a', runtimeSurface: 'hatchet',
                createdAt: '2026-07-19T00:00:01.000Z', enqueuedAt: '2026-07-19T00:00:00.000Z',
            },
        },
        {
            dispatchIntent: {
                generation: '1', deliveryKey: 'wake-a', runtimeSurface: 'hatchet',
                createdAt: '2026-07-19',
            },
        },
    ])('rejects inconsistent claim and dispatch relationships %#', (override) => {
        const snapshot = {
            meta: {
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '1',
                    completedGeneration: '0',
                    ...override,
                },
            },
        };
        expect(() => readTaskTurnCoordinator(snapshot, {
            tenantId: 'tenant-a', taskId: 'task-a',
        })).toThrow(expect.objectContaining({ code: 'TASK_TURN_COORDINATOR_INVALID' }));
    });

    it('does not silently initialize execution state', () => {
        expect(() => readTaskTurnCoordinator({}, {
            tenantId: 'tenant-a', taskId: 'task-a',
        })).toThrow(expect.objectContaining({ code: 'TASK_TURN_COORDINATOR_INVALID' }));
    });

    it('uses the repository clock when deciding lease takeover', async () => {
        let clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const session = new SessionManager(new InMemorySessionManager(() => clockMs));
        await session.saveSnapshot({
            tenantId: 'tenant-a',
            sessionId: 'task-a',
            agentId: 'agent-a',
            expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'agent-a' } },
        });
        const first = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-a',
            requestKey: 'task-a:start',
            leaseMs: 1_000,
            // A deliberately wrong worker clock must not affect the lease.
            now: () => Date.parse('2035-01-01T00:00:00.000Z'),
            allowInitialize: true,
        });
        expect(first.result.disposition).toBe('acquired');
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');
        expect(first.result.claim.acquiredAt).toBe('2026-07-19T00:00:00.000Z');

        clockMs += 11_001;
        const takeover = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-b',
            requestKey: 'task-a:input:next',
            leaseMs: 1_000,
            now: () => Date.parse('2020-01-01T00:00:00.000Z'),
        });
        expect(takeover.result.disposition).toBe('acquired');
        if (takeover.result.disposition !== 'acquired') throw new Error('takeover missing');
        expect(takeover.result.claim.fence).toBe('2');
    });

    it('admits one concurrent owner and durably queues the other wake', async () => {
        const session = await seededSession();
        const [first, second] = await Promise.all([
            requestTaskTurn({
                session,
                tenantId: 'tenant-a',
                taskId: 'task-a',
                ownerId: 'worker-a',
                requestKey: 'task-a:start',
            }),
            requestTaskTurn({
                session,
                tenantId: 'tenant-a',
                taskId: 'task-a',
                ownerId: 'worker-b',
                requestKey: 'task-a:input:1',
            }),
        ]);

        const results = [first.result, second.result];
        expect(results.filter((value) => value.disposition === 'acquired')).toHaveLength(1);
        expect(results.filter((value) => value.disposition === 'queued')).toHaveLength(1);
        const loaded = await session.load('tenant-a', 'task-a');
        const state = readTaskTurnCoordinator(loaded?.snapshot);
        expect(state.requestedGeneration).toBe('2');
        expect(state.completedGeneration).toBe('0');
        expect(state.active?.fence).toBe('1');
        expect((loaded?.snapshot as any).meta.processedKeys).toEqual(
            expect.arrayContaining(['task-a:start', 'task-a:input:1'])
        );
    });

    it('allocates a higher fence for queued work after the first owner releases', async () => {
        const session = await seededSession();
        const first = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-a',
            requestKey: 'task-a:start',
        });
        expect(first.result.disposition).toBe('acquired');
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');
        await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-b',
            requestKey: 'task-a:input:1',
        });
        await releaseTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            claim: first.result.claim,
        });

        const second = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-b',
            requestKey: 'task-a:input:1',
        });
        expect(second.result.disposition).toBe('acquired');
        if (second.result.disposition !== 'acquired') throw new Error('second claim missing');
        expect(second.result.claim.fence).toBe('2');
        expect(second.result.claim.claimedGeneration).toBe('2');
    });

    it('rejects effect registration from a replaced fence', async () => {
        const session = await seededSession();
        const first = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-a',
            requestKey: 'task-a:start',
        });
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');
        await releaseTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            claim: first.result.claim,
        });
        const second = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'worker-b',
            requestKey: 'task-a:input:1',
        });
        expect(second.result.disposition).toBe('acquired');

        const mutate = jest.fn(({ snapshot }: any) => ({ snapshot, value: 'never' }));
        await expect(runWithSegmentIdempotencyKey(
            'task-a:start',
            () => registerTaskEffect({
                session,
                tenantId: 'tenant-a',
                taskId: 'task-a',
                effectKind: 'tool',
                operation: 'test.stale_effect',
                mutate,
            }),
            { ...first.result.claim, tenantId: 'tenant-a', taskId: 'task-a' }
        )).rejects.toMatchObject({ code: 'TASK_TURN_SUPERSEDED' });
        expect(mutate).not.toHaveBeenCalled();
    });

    it('rejects renewal and effect registration at the exact expiry boundary', async () => {
        let clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const session = new SessionManager(new InMemorySessionManager(() => clockMs));
        await session.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: {
                meta: {
                    taskLifecycle: { taskId: 'task-a', rootTaskId: 'task-a', ancestorTaskIds: [], state: 'active' },
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
                },
            },
        });
        const requested = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-a',
            requestKey: 'task-a:start', leaseMs: 1_000,
        });
        if (requested.result.disposition !== 'acquired') throw new Error('claim missing');
        clockMs = Date.parse(requested.result.claim.expiresAt);
        await expect(renewTaskTurnClaim({
            session, tenantId: 'tenant-a', taskId: 'task-a', claim: requested.result.claim, leaseMs: 1_000,
        })).resolves.toBe('expired');
        await expect(runWithSegmentIdempotencyKey(
            'task-a:start',
            () => registerTaskEffect({
                session, tenantId: 'tenant-a', taskId: 'task-a', effectKind: 'tool',
                operation: 'test.expired_effect',
                mutate: ({ snapshot }) => ({ snapshot, value: 'never' }),
            }),
            { ...requested.result.claim, tenantId: 'tenant-a', taskId: 'task-a' },
        )).rejects.toMatchObject({ code: 'TASK_TURN_SUPERSEDED' });
    });

    it('does not rescan a recently enqueued dispatch intent until its recovery window is overdue', async () => {
        let clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const store = new InMemorySessionManager(() => clockMs);
        const session = new SessionManager(store);
        await session.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: {
                meta: {
                    taskLifecycle: { taskId: 'task-a', rootTaskId: 'task-a', ancestorTaskIds: [], state: 'active' },
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
                },
            },
        });
        const requested = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-a',
            requestKey: 'task-a:start', runtimeSurface: 'hatchet',
        });
        if (requested.result.disposition !== 'acquired') throw new Error('claim missing');
        await releaseTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', claim: requested.result.claim,
        });
        const intent = readTaskTurnCoordinator((await session.load('tenant-a', 'task-a'))?.snapshot).dispatchIntent!;
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(1);
        await markTaskTurnDispatchEnqueued({
            session, tenantId: 'tenant-a', taskId: 'task-a', agentId: 'agent-a',
            generation: intent.generation, deliveryKey: intent.deliveryKey,
        });
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(0);
        clockMs += 15_001;
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(1);
    });
});
