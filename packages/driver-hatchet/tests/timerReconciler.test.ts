import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { defaultMetricsRegistry, type RuntimeTimerRecord } from '@a2arium/callagent-core/unstable';
import { TimerReconciler } from '../src/timerReconciler.js';

describe('TimerReconciler metrics', () => {
    afterEach(() => {
        defaultMetricsRegistry.reset();
    });

    it('records due count, lag, enqueue, and scan duration metrics', async () => {
        const now = new Date('2026-06-24T00:00:10.000Z');
        const timer = makeTimer({
            dueAt: new Date('2026-06-24T00:00:00.000Z'),
        });
        const runtimeTimers = {
            listDue: jest.fn(async () => [timer]),
            attachProviderRun: jest.fn(async () => undefined),
        };
        const timerFireTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('provider-run-1') })),
        };
        const reconciler = new TimerReconciler(runtimeTimers as never, timerFireTask as never);

        await expect(reconciler.scanOnce(now)).resolves.toBe(1);

        expect(runtimeTimers.attachProviderRun).toHaveBeenCalledWith({
            id: 'timer-row-1',
            providerRunId: 'provider-run-1',
        });
        const snapshot = defaultMetricsRegistry.snapshot();
        expect(snapshot.gauges).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'runtime.timer_due_count', value: 1 }),
            expect.objectContaining({ name: 'runtime.timer_lag_ms', value: 10_000 }),
        ]));
        expect(snapshot.counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'hatchet.enqueue_total',
                dimensions: expect.objectContaining({
                    operation: 'timer.fire',
                    status: 'completed',
                }),
            }),
        ]));
        expect(snapshot.durations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.timer_reconcile_ms',
                dimensions: expect.objectContaining({ status: 'completed' }),
            }),
        ]));
    });

    it('records failed timer reconciliation scans', async () => {
        const runtimeTimers = {
            listDue: jest.fn(async () => {
                throw new TypeError('database unavailable');
            }),
        };
        const reconciler = new TimerReconciler(runtimeTimers as never, { runNoWait: jest.fn() } as never);

        await expect(reconciler.scanOnce()).rejects.toThrow('database unavailable');

        const snapshot = defaultMetricsRegistry.snapshot();
        expect(snapshot.counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.timer_reconcile_failure_total',
                dimensions: expect.objectContaining({
                    phase: 'scan',
                    errorCode: 'TypeError',
                }),
            }),
        ]));
        expect(snapshot.durations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.timer_reconcile_ms',
                dimensions: expect.objectContaining({
                    status: 'failed',
                    errorCode: 'TypeError',
                }),
            }),
        ]));
    });
});

function makeTimer(overrides: Partial<RuntimeTimerRecord> = {}): RuntimeTimerRecord {
    return {
        id: 'timer-row-1',
        tenantId: 'tenant-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        rootTaskId: 'task-1',
        token: 'tok-1',
        timerId: 'timer-1',
        dueAt: new Date('2026-06-24T00:00:00.000Z'),
        kind: 'token_expiry',
        status: 'scheduled',
        idempotencyKey: 'timer:tenant-1:task-1:tok-1:timer-1',
        fireLeaseId: null,
        fireLeaseUntil: null,
        payload: null,
        providerRunId: null,
        providerTaskRunId: null,
        error: null,
        firedAt: null,
        canceledAt: null,
        createdAt: new Date('2026-06-24T00:00:00.000Z'),
        updatedAt: new Date('2026-06-24T00:00:00.000Z'),
        ...overrides,
    };
}
