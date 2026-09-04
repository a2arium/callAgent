import { describe, expect, it, jest } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import {
    advanceTaskTurnGenerationInSnapshot,
    completeTaskTurnInSnapshot,
    readTaskTurnCoordinator,
    markTaskTurnDispatchEnqueued,
    releaseTaskTurn,
    requestTaskTurn,
    renewTaskTurnClaim,
    recoverExpiredTaskTurnClaim,
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
    it('persists runtime affinity and rejects claims from another surface', async () => {
        const session = await seededSession();
        const first = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'hatchet-worker',
            requestKey: 'task-a:start',
            runtimeSurface: 'hatchet',
        });
        expect(first.result.disposition).toBe('acquired');
        expect(readTaskTurnCoordinator(first.snapshot).runtimeSurface).toBe('hatchet');

        await expect(requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'local-worker',
            requestKey: 'task-a:child:1',
            runtimeSurface: 'in_process',
        })).rejects.toMatchObject({ code: 'TASK_TURN_COORDINATOR_INVALID' });
    });

    it('routes terminal-generated demand to the persisted task surface', () => {
        const advanced = advanceTaskTurnGenerationInSnapshot({
            snapshot: {
                meta: {
                    turnCoordinator: {
                        schemaVersion: 1,
                        runtimeSurface: 'hatchet',
                        nextFence: '1',
                        nextTurnSeq: 1,
                        requestedGeneration: '1',
                        completedGeneration: '1',
                    },
                },
            },
            tenantId: 'tenant-a',
            taskId: 'task-a',
            runtimeSurface: 'in_process',
            storageNow: '2026-07-22T10:00:00.000Z',
        });

        expect(advanced.state.runtimeSurface).toBe('hatchet');
        expect(advanced.state.dispatchIntent?.runtimeSurface).toBe('hatchet');
    });

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

    it('reuses the logical turn sequence when the same generation is recovered', async () => {
        let clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const session = new SessionManager(new InMemorySessionManager(() => clockMs));
        await session.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'agent-a' } },
        });
        const first = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-a',
            requestKey: 'task-a:start', leaseMs: 1_000, takeoverGraceMs: 100,
            allowInitialize: true,
        });
        expect(first.result.disposition).toBe('acquired');
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');

        clockMs += 1_101;
        const recovered = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-b',
            requestKey: 'task-a:start', leaseMs: 1_000, takeoverGraceMs: 100,
        });

        expect(recovered.result.disposition).toBe('acquired');
        if (recovered.result.disposition !== 'acquired') throw new Error('recovery missing');
        expect(recovered.result.claim).toMatchObject({
            claimedGeneration: '1', turnSeq: 1, fence: '2',
        });
        expect(recovered.result.replacedClaim).toMatchObject({
            claimId: first.result.claim.claimId, claimedGeneration: '1', turnSeq: 1, fence: '1',
        });
        expect(readTaskTurnCoordinator(recovered.snapshot).nextTurnSeq).toBe(1);
    });

    it('preserves an allocated logical sequence when an unstarted claim is released', async () => {
        const session = await seededSession();
        const first = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-a',
            requestKey: 'task-a:start',
        });
        expect(first.result.disposition).toBe('acquired');
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');
        await releaseTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', claim: first.result.claim,
        });
        const released = readTaskTurnCoordinator((await session.load('tenant-a', 'task-a'))?.snapshot);
        expect(released.dispatchIntent).toMatchObject({ generation: '1', turnSeq: 1 });

        const retried = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-b',
            requestKey: 'task-a:start',
        });
        expect(retried.result.disposition).toBe('acquired');
        if (retried.result.disposition !== 'acquired') throw new Error('retry missing');
        expect(retried.result.claim).toMatchObject({ claimedGeneration: '1', turnSeq: 1, fence: '2' });
    });

    it('recovers a coordinator claim whose storage heartbeat is implausibly in the future', async () => {
        const clockMs = Date.parse('2026-07-19T00:00:00.000Z');
        const session = new SessionManager(new InMemorySessionManager(() => clockMs));
        await session.saveSnapshot({
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', expectedWmVersion: 0n,
            snapshot: {
                meta: {
                    taskLifecycle: { taskId: 'task-a', rootTaskId: 'task-a', ancestorTaskIds: [], state: 'active' },
                    turnCoordinator: {
                        schemaVersion: 1,
                        nextFence: '1',
                        nextTurnSeq: 1,
                        requestedGeneration: '1',
                        completedGeneration: '0',
                        active: {
                            claimId: 'bad-clock-claim', fence: '1', ownerId: 'old-worker', requestKey: 'task-a:start',
                            claimedGeneration: '1', turnSeq: 1, phase: 'executing', runtimeSurface: 'hatchet',
                            acquiredAt: '2026-07-19T02:59:00.000Z',
                            heartbeatAt: '2026-07-19T03:00:00.000Z',
                            expiresAt: '2026-07-19T03:02:00.000Z',
                        },
                    },
                },
            },
        });

        const recovered = await requestTaskTurn({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            ownerId: 'new-worker',
            requestKey: 'task-a:recovery',
            runtimeSurface: 'hatchet',
            leaseMs: 120_000,
        });

        expect(recovered.result.disposition).toBe('acquired');
        if (recovered.result.disposition !== 'acquired') throw new Error('claim missing');
        expect(recovered.result.claim.fence).toBe('2');
        expect(recovered.result.claim.claimedGeneration).toBe('2');
        expect(recovered.result.claim.acquiredAt).toBe('2026-07-19T00:00:00.000Z');
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
        expect(second.result.claim.turnSeq).toBe(2);
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
        await expect(markTaskTurnDispatchEnqueued({
            session, tenantId: 'tenant-a', taskId: 'task-a', agentId: 'agent-a',
            generation: intent.generation, deliveryKey: intent.deliveryKey,
            runtimeSurface: 'in_process',
        })).resolves.toBe('stale');
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(1);
        await markTaskTurnDispatchEnqueued({
            session, tenantId: 'tenant-a', taskId: 'task-a', agentId: 'agent-a',
            generation: intent.generation, deliveryKey: intent.deliveryKey,
            runtimeSurface: 'hatchet',
        });
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(0);
        clockMs += 15_001;
        await expect(session.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(1);
    });

    it('redelivers an expired generation before later queued demand with the same logical turn', async () => {
        let clockMs = Date.parse('2026-09-04T10:00:00.000Z');
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
        const first = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-a',
            requestKey: 'task-a:start', runtimeSurface: 'hatchet', leaseMs: 1_000,
        });
        if (first.result.disposition !== 'acquired') throw new Error('claim missing');
        await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-b',
            requestKey: 'task-a:wake:2', runtimeSurface: 'hatchet', leaseMs: 1_000,
        });
        await expect(recoverExpiredTaskTurnClaim({
            session, tenantId: 'tenant-a', taskId: 'task-a', expectedClaim: first.result.claim,
        })).resolves.toMatchObject({ disposition: 'not_expired' });
        clockMs = Date.parse(first.result.claim.expiresAt);

        await expect(recoverExpiredTaskTurnClaim({
            session, tenantId: 'tenant-a', taskId: 'task-a', expectedClaim: first.result.claim,
        })).resolves.toMatchObject({ disposition: 'recovery_staged' });
        await expect(recoverExpiredTaskTurnClaim({
            session, tenantId: 'tenant-a', taskId: 'task-a', expectedClaim: first.result.claim,
        })).resolves.toMatchObject({ disposition: 'already_recovering' });
        let state = readTaskTurnCoordinator((await session.load('tenant-a', 'task-a'))?.snapshot);
        expect(state).toMatchObject({
            requestedGeneration: '2', completedGeneration: '0',
            dispatchIntent: {
                generation: '1', turnSeq: first.result.claim.turnSeq,
                deliveryKey: 'task-a:turn-request:1', recovery: { reason: 'lease_expired' },
            },
        });
        expect(state.active).toBeUndefined();

        const laterWake = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-c',
            requestKey: 'task-a:wake:3', runtimeSurface: 'hatchet', leaseMs: 1_000,
        });
        expect(laterWake.result.disposition).toBe('queued');
        state = readTaskTurnCoordinator((await session.load('tenant-a', 'task-a'))?.snapshot);
        expect(state.requestedGeneration).toBe('3');
        expect(state.dispatchIntent?.generation).toBe('1');

        const recovered = await requestTaskTurn({
            session, tenantId: 'tenant-a', taskId: 'task-a', ownerId: 'worker-recovery',
            requestKey: 'task-a:turn-request:1', runtimeSurface: 'hatchet', leaseMs: 1_000,
            recoveryGeneration: '1',
        });
        if (recovered.result.disposition !== 'acquired') throw new Error('recovery claim missing');
        expect(recovered.result.claim).toMatchObject({
            claimedGeneration: '1', turnSeq: first.result.claim.turnSeq, fence: '2',
        });
        expect(recovered.result.claim.claimId).not.toBe(first.result.claim.claimId);
        expect(recovered.result.replacedClaim?.claimId).toBe(first.result.claim.claimId);

        const completed = completeTaskTurnInSnapshot(recovered.snapshot, {
            tenantId: 'tenant-a', taskId: 'task-a', claim: recovered.result.claim,
            storageNow: clockMs.toString() === '' ? '' : new Date(clockMs).toISOString(),
        });
        expect(completed.disposition).toBe('committed');
        expect(readTaskTurnCoordinator(completed.snapshot).dispatchIntent).toMatchObject({ generation: '3' });
    });

    it('discovers expired claims by surface with stable keyset pagination', async () => {
        let clockMs = Date.parse('2026-09-04T11:00:00.000Z');
        const store = new InMemorySessionManager(() => clockMs);
        const session = new SessionManager(store);
        for (const taskId of ['task-a', 'task-b']) {
            await session.saveSnapshot({
                tenantId: 'tenant-a', sessionId: taskId, agentId: 'agent-a', expectedWmVersion: 0n,
                snapshot: { meta: {
                    taskLifecycle: { taskId, rootTaskId: taskId, ancestorTaskIds: [], state: 'active' },
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '1', nextTurnSeq: 1,
                        requestedGeneration: '1', completedGeneration: '0',
                        active: {
                            claimId: `claim-${taskId}`, fence: '1', ownerId: 'worker-a',
                            requestKey: `${taskId}:start`, claimedGeneration: '1', turnSeq: 1,
                            phase: 'executing', runtimeSurface: 'hatchet',
                            acquiredAt: '2026-09-04T10:00:00.000Z',
                            heartbeatAt: '2026-09-04T10:00:00.000Z',
                            expiresAt: '2026-09-04T10:01:00.000Z',
                        },
                    },
                } },
            });
        }
        const first = await session.listExpiredTaskTurnClaims({ runtimeSurface: 'hatchet', limit: 1 });
        expect(first.map((row) => row.taskId)).toEqual(['task-a']);
        const second = await session.listExpiredTaskTurnClaims({
            runtimeSurface: 'hatchet', limit: 1,
            cursor: { expiresAt: first[0]!.expiresAt, tenantId: first[0]!.tenantId, taskId: first[0]!.taskId },
        });
        expect(second.map((row) => row.taskId)).toEqual(['task-b']);
        await expect(session.listExpiredTaskTurnClaims({ runtimeSurface: 'in_process', limit: 10 }))
            .resolves.toEqual([]);
    });
});
