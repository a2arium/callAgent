import { describe, expect, it, jest } from '@jest/globals';
import { convergeProviderTerminal, ProviderTerminalReconciler } from '../src/providerTerminalReconciler.js';
import { claimTaskTerminalInSnapshot, readDurableTaskTerminal } from '@a2arium/callagent-core/unstable';

describe('provider terminal convergence', () => {
    it('makes a failed provider run authoritative and publishes one final delivery key', async () => {
        let snapshot: Record<string, unknown> = {};
        let version = BigInt(0);
        const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const enqueueOutbox = jest.fn(async () => ({ id: 'outbox-1' }));
        const sessions = {
            loadForMutation: jest.fn(async () => ({ snapshot, wmVersion: version, agentId: 'agent-a' })),
            saveSnapshot: jest.fn(async (params: { snapshot: Record<string, unknown> }) => {
                snapshot = params.snapshot;
                version += BigInt(1);
                return { newVersion: version };
            }),
            listEventsSince: jest.fn(async () => events),
            appendEvent: jest.fn(async (_tenant: string, _task: string, type: string, payload: Record<string, unknown>) => {
                events.push({ type, payload });
                return { eventId: 'event-1', seq: 1 };
            }),
            enqueueOutbox,
        };

        const changed = await convergeProviderTerminal(sessions as any, {
            tenantId: 'tenant-a',
            taskId: 'task-a',
            agentId: 'agent-a',
            providerRunId: 'provider-a',
            error: new Error('durable stream error: connection dropped'),
            observedAt: new Date('2026-09-04T00:00:00.000Z'),
        });

        expect(changed).toBe(true);
        expect(readDurableTaskTerminal(snapshot)).toMatchObject({
            state: 'failed',
            status: { metadata: { code: 'HATCHET_DURABLE_STREAM_UNAVAILABLE' } },
        });
        expect(events).toEqual([expect.objectContaining({ type: 'task.failed' })]);
        expect(enqueueOutbox).toHaveBeenCalledWith(
            'tenant-a', 'task.status', 'task-a', expect.objectContaining({ final: true }), undefined, 'task-a:terminal:failed',
        );
    });
});

it('corrects only a timeout cancellation that happened after the provider failure', async () => {
    let snapshot = claimTaskTerminalInSnapshot({}, {
        taskId: 'task-a', state: 'canceled', claimedAt: '2026-09-04T00:02:00.000Z', reason: 'active_run_timeout',
        status: { state: 'canceled', timestamp: '2026-09-04T00:02:00.000Z', metadata: { code: 'TASK_RUN_TIMEOUT' } },
    }).snapshot;
    let version = BigInt(0);
    const sessions = {
        loadForMutation: jest.fn(async () => ({ snapshot, wmVersion: version, agentId: 'agent-a' })),
        saveSnapshot: jest.fn(async (params: { snapshot: typeof snapshot }) => {
            snapshot = params.snapshot;
            version += BigInt(1);
            return { newVersion: version };
        }),
        listEventsSince: jest.fn(async () => []),
        appendEvent: jest.fn(async () => ({ eventId: 'event-1', seq: 1 })),
        enqueueOutbox: jest.fn(async () => ({ id: 'outbox-1' })),
    };

    const changed = await convergeProviderTerminal(sessions as any, {
        tenantId: 'tenant-a', taskId: 'task-a', agentId: 'agent-a', observedAt: new Date('2026-09-04T00:01:00.000Z'),
        error: new Error('provider ended first'),
    });

    expect(changed).toBe(true);
    expect(readDurableTaskTerminal(snapshot)).toMatchObject({
        state: 'failed', status: { metadata: { supersedesDeliveryKey: 'task-a:terminal:canceled' } },
    });
});

it('records only a stable failed Hatchet provider status before reconciling terminal rows', async () => {
    const findMany = jest.fn()
        .mockResolvedValueOnce([{ id: 'row-a', providerRunId: 'provider-a' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'row-a', providerRunId: 'provider-a' }])
        .mockResolvedValueOnce([]);
    const updateMany = jest.fn(async () => ({ count: 1 }));
    let now = new Date('2026-09-05T00:00:00.000Z');
    const reconciler = new ProviderTerminalReconciler(
        { driverRun: { findMany, updateMany } },
        {} as any,
        { runs: { get_status: jest.fn(async () => 'FAILED') } } as any,
        () => now,
        15_000,
    );

    await reconciler.scanOnce();
    expect(updateMany).not.toHaveBeenCalled();

    now = new Date('2026-09-05T00:00:15.000Z');
    await reconciler.scanOnce();

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'row-a', status: { in: ['queued', 'running'] } },
        data: expect.objectContaining({ status: 'failed' }),
    }));
});

it('forgets a provisional provider failure when the run recovers', async () => {
    const findMany = jest.fn()
        .mockResolvedValueOnce([{ id: 'row-a', providerRunId: 'provider-a' }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'row-a', providerRunId: 'provider-a' }]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'row-a', providerRunId: 'provider-a' }]).mockResolvedValueOnce([]);
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const getStatus = jest.fn()
        .mockResolvedValueOnce('FAILED')
        .mockResolvedValueOnce('RUNNING')
        .mockResolvedValueOnce('FAILED');
    let nowMs = 0;
    const reconciler = new ProviderTerminalReconciler(
        { driverRun: { findMany, updateMany } }, {} as any,
        { runs: { get_status: getStatus } } as any,
        () => new Date(nowMs), 15_000,
    );

    await reconciler.scanOnce();
    nowMs = 15_000;
    await reconciler.scanOnce();
    nowMs = 30_000;
    await reconciler.scanOnce();

    expect(updateMany).not.toHaveBeenCalled();
});
