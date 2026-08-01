import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import type { EnqueueStartParams, RuntimeDriver } from '../src/runtime/runtimeDriver.js';
import {
    canonicalizeTaskSubmissionInput,
    MAX_TASK_RUN_TIMEOUT_MS,
    normalizeTaskSubmissionRunTimeout,
    TaskSubmissionError,
    taskSubmissionRequestDigest,
} from '../src/orchestration/TaskSubmission.js';
import { readTaskTurnCoordinator } from '../src/orchestration/TaskTurnCoordinator.js';
import { requestTaskTurn } from '../src/orchestration/TaskTurnCoordinator.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { defaultMetricsRegistry } from '../src/observability/metrics.js';
import { observeTaskSubmissionBacklog } from '../src/orchestration/taskSubmissionObservability.js';

class DurableTestStore extends InMemorySessionManager {
    readonly taskAdmissionCapabilities = {
        durablePersistence: true,
        runnableTurnRecovery: true,
    } as const;
}

class FailFirstEnqueueAckStore extends DurableTestStore {
    private failAck = true;

    override async writeSnapshotCAS(
        params: Parameters<DurableTestStore['writeSnapshotCAS']>[0]
    ): ReturnType<DurableTestStore['writeSnapshotCAS']> {
        const coordinator = readTaskTurnCoordinator(params.snapshot);
        if (this.failAck && coordinator.dispatchIntent?.enqueuedAt !== undefined) {
            this.failAck = false;
            throw new Error('simulated crash before enqueue acknowledgement');
        }
        return super.writeSnapshotCAS(params);
    }
}

class ProjectionRepairStore extends DurableTestStore {
    readonly projectionUpsert = jest
        .fn<(args: Record<string, unknown>) => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('projection temporarily unavailable'))
        .mockResolvedValue({});
    readonly prisma = { agentRun: { upsert: this.projectionUpsert } };
}

function admissionDriver(options?: { publishError?: Error }): RuntimeDriver & {
    enqueueStart: jest.Mock<(params: EnqueueStartParams) => Promise<void>>;
} {
    const enqueueStart = jest.fn(async (_params: EnqueueStartParams) => {
        if (options?.publishError) throw options.publishError;
    });
    return {
        surface: 'in_process',
        taskAdmissionCapabilities: {
            recoverableStarts: true,
            preflightStart: jest.fn(async () => undefined),
        },
        enqueueStart,
        enqueueResume: jest.fn(async () => undefined),
        enqueueChildDispatch: jest.fn(async () => undefined),
        scheduleTimer: jest.fn(async () => ({ timerId: 'timer' })),
        cancelTimer: jest.fn(async () => undefined),
        cancel: jest.fn(async () => undefined),
        dispatchOutbox: jest.fn(async () => undefined),
    };
}

const loopPlugin = {
    resolved: {
        runtimeManifest: {
            name: 'admission-agent',
            version: '1.0.0',
            runMode: 'loop' as const,
            budgets: { maxTurns: 10 },
        },
        runtimeManifestSource: 'test',
        agentCard: { name: 'admission-agent', version: '1.0.0' },
        agentCardSource: 'test',
    },
};

describe('durable task submission', () => {
    beforeEach(() => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        defaultMetricsRegistry.reset();
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(loopPlugin as never);
    });

    afterEach(() => {
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
        jest.restoreAllMocks();
    });

    it('atomically admits generation one and schedules without calling TurnRunner inline', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const runTurn = jest.spyOn(
            (engine as unknown as { turnRunner: { runTurn: (...args: never[]) => Promise<unknown> } }).turnRunner,
            'runTurn'
        );

        const result = await engine.submitTask({
            tenantId: 'tenant_a',
            taskId: 'task-a',
            agentId: 'admission-agent',
            input: { z: 2, a: [true, null] },
            options: { maxTurns: 7 },
        });

        expect(result).toEqual({ taskId: 'task-a', status: 'accepted' });
        expect(runTurn).not.toHaveBeenCalled();
        expect(driver.enqueueStart).toHaveBeenCalledWith(expect.objectContaining({
            idempotencyKey: 'task-a:turn-request:1',
            recoveryGeneration: '1',
            recoveryDeliveryKey: 'task-a:turn-request:1',
        }));
        const stored = await store.getSessionSnapshot('tenant_a', 'task-a');
        const snapshot = stored?.snapshot as Record<string, unknown>;
        const meta = snapshot.meta as Record<string, unknown>;
        expect(meta.initialInput).toEqual({ a: [true, null], z: 2 });
        expect(meta.replyDeliveryMode).toBe('buffer');
        expect(meta.budgets).toEqual({ maxTurns: 7 });
        expect(meta.taskLifecycle).toMatchObject({
            taskId: 'task-a', rootTaskId: 'task-a', state: 'active', ancestorTaskIds: [],
        });
        expect(readTaskTurnCoordinator(snapshot)).toMatchObject({
            requestedGeneration: '1',
            completedGeneration: '0',
            runtimeSurface: 'in_process',
        });
        expect(driver.scheduleTimer).not.toHaveBeenCalled();
    });

    it('binds an absolute storage-clock deadline before publishing the admitted root', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const timeoutMs = 32 * 60_000;
        const request = {
            tenantId: 'tenant_a', taskId: 'bounded-root', agentId: 'admission-agent', input: {},
            options: { maxTurns: 20, taskRunTimeoutMs: timeoutMs },
        } as const;

        await expect(engine.submitTask(request)).resolves.toEqual({
            taskId: request.taskId,
            status: 'accepted',
        });
        expect(driver.scheduleTimer).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: request.tenantId,
            taskId: request.taskId,
            token: 'root-run-timeout',
            kind: 'task_run_timeout',
        }));
        expect((driver.scheduleTimer as jest.Mock).mock.invocationCallOrder[0])
            .toBeLessThan(driver.enqueueStart.mock.invocationCallOrder[0]!);

        const stored = await store.getSessionSnapshot(request.tenantId, request.taskId);
        const meta = stored?.snapshot.meta as Record<string, any>;
        expect(meta.taskSubmission.options).toEqual({ maxTurns: 20, taskRunTimeoutMs: timeoutMs });
        expect(meta.rootRunDeadline).toMatchObject({
            timeoutMs,
            startedAt: meta.taskSubmission.admittedAt,
            source: 'task_submission',
            timerToken: 'root-run-timeout',
        });
        expect(Date.parse(meta.rootRunDeadline.expiresAt) - Date.parse(meta.rootRunDeadline.startedAt))
            .toBe(timeoutMs);

        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'duplicate_active' });
        expect(driver.enqueueStart).toHaveBeenCalledTimes(1);
        expect(driver.scheduleTimer).toHaveBeenCalledTimes(2);
        const firstTimer = (driver.scheduleTimer as jest.Mock).mock.calls[0]![0] as { fireAt: string };
        const repairedTimer = (driver.scheduleTimer as jest.Mock).mock.calls[1]![0] as { fireAt: string };
        expect(repairedTimer.fireAt).toBe(firstTimer.fireAt);
        await expect(engine.submitTask({
            ...request,
            options: { ...request.options, taskRunTimeoutMs: timeoutMs + 1 },
        })).rejects.toMatchObject({ code: 'TASK_SUBMISSION_CONFLICT' });
        await expect(engine.submitTask({ ...request, options: { maxTurns: 20 } }))
            .rejects.toMatchObject({ code: 'TASK_SUBMISSION_CONFLICT' });
    });

    it('keeps a timed admission recoverable when deadline timer storage is unavailable', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        (driver.scheduleTimer as jest.Mock).mockRejectedValueOnce(new Error('timer storage unavailable'));
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });

        await expect(engine.submitTask({
            tenantId: 'tenant_a', taskId: 'timer-deferred', agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        })).resolves.toEqual({ taskId: 'timer-deferred', status: 'accepted' });

        expect(driver.enqueueStart).not.toHaveBeenCalled();
        const stored = await store.getSessionSnapshot('tenant_a', 'timer-deferred');
        expect((stored?.snapshot.meta as Record<string, any>).rootRunDeadline).toBeDefined();
        expect(readTaskTurnCoordinator(stored?.snapshot).dispatchIntent).toMatchObject({
            generation: '1',
            deliveryKey: 'timer-deferred:turn-request:1',
        });

        await expect(engine.submitTask({
            tenantId: 'tenant_a', taskId: 'timer-deferred', agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        })).resolves.toEqual({ taskId: 'timer-deferred', status: 'duplicate_active' });
        expect(driver.scheduleTimer).toHaveBeenCalledTimes(2);
        expect(driver.enqueueStart).not.toHaveBeenCalled();
    });

    it('cancels the root deadline timer when the admitted task converges terminally', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const taskId = 'bounded-completion';

        await engine.submitTask({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        });
        jest.spyOn(
            (engine as unknown as { turnRunner: { runTurn: (...args: never[]) => Promise<unknown> } }).turnRunner,
            'runTurn'
        ).mockResolvedValue({
            id: taskId,
            input: {},
            status: { state: 'completed', timestamp: new Date().toISOString() },
        });

        await expect(engine.getCompositionTurnExecutor().runSegment({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent',
            idempotencyKey: `${taskId}:turn-request:1`,
            runtimeSurface: 'in_process',
            recoveryGeneration: '1',
            wake: { trigger: 'start', input: {} },
        })).resolves.toMatchObject({ taskStatus: 'completed' });

        expect(driver.cancelTimer).toHaveBeenCalledWith({
            tenantId: 'tenant_a',
            taskId,
            token: 'root-run-timeout',
        });
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TASK_RUN_TIMEOUT_MS + 1])(
        'rejects invalid taskRunTimeoutMs %p before durable admission side effects',
        async (taskRunTimeoutMs) => {
            const store = new DurableTestStore();
            const driver = admissionDriver();
            const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });

            await expect(engine.submitTask({
                tenantId: 'tenant_a', taskId: 'invalid-timeout', agentId: 'admission-agent', input: {},
                options: { taskRunTimeoutMs },
            })).rejects.toMatchObject({ code: 'TASK_SUBMISSION_OPTIONS_INVALID' });
            expect(driver.scheduleTimer).not.toHaveBeenCalled();
            expect(driver.enqueueStart).not.toHaveBeenCalled();
            await expect(store.getSessionSnapshot('tenant_a', 'invalid-timeout')).resolves.toBeNull();
        }
    );

    it('cancels an admitted root before its first recovered segment when the deadline expired', async () => {
        const workerNow = Date.parse('2026-08-01T00:00:00.000Z');
        let storageNow = workerNow;
        jest.spyOn(Date, 'now').mockImplementation(() => workerNow);
        const store = new DurableTestStore(() => storageNow);
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const runTurn = jest.spyOn(
            (engine as unknown as { turnRunner: { runTurn: (...args: never[]) => Promise<unknown> } }).turnRunner,
            'runTurn'
        );
        const taskId = 'expired-before-start';

        await engine.submitTask({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        });
        storageNow += 60_001;

        const result = await engine.getCompositionTurnExecutor().runSegment({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent',
            idempotencyKey: `${taskId}:turn-request:1`,
            runtimeSurface: 'in_process',
            recoveryGeneration: '1',
            wake: { trigger: 'start', input: {} },
        });

        expect(result.taskStatus).toBe('canceled');
        expect(runTurn).not.toHaveBeenCalled();
        expect(driver.cancel).toHaveBeenCalledWith(expect.objectContaining({
            taskId,
            reason: 'active_run_timeout',
        }));
        const stored = await store.getSessionSnapshot('tenant_a', taskId);
        expect((stored?.snapshot.meta as Record<string, any>).taskTerminal.status).toMatchObject({
            state: 'canceled',
            metadata: {
                reason: 'active_run_timeout',
                code: 'TASK_RUN_TIMEOUT',
                timeoutMs: 60_000,
            },
        });
    });

    it('does not fire a root timeout early when the worker clock is ahead of storage', async () => {
        const storageNow = Date.parse('2026-08-01T00:00:00.000Z');
        jest.spyOn(Date, 'now').mockImplementation(() => storageNow + 5 * 60_000);
        const store = new DurableTestStore(() => storageNow);
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const taskId = 'worker-clock-ahead';

        await engine.submitTask({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        });
        const stored = await store.getSessionSnapshot('tenant_a', taskId);
        const deadline = (stored?.snapshot.meta as Record<string, any>).rootRunDeadline;

        await expect(engine.handleTaskRunTimeout({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent',
            token: deadline.timerToken,
            dueAt: deadline.expiresAt,
        })).resolves.toBe('not_due');

        expect(driver.cancel).not.toHaveBeenCalled();
        const after = await store.getSessionSnapshot('tenant_a', taskId);
        expect((after?.snapshot.meta as Record<string, any>).taskLifecycle.state).toBe('active');
    });

    it('ignores a timeout callback whose durable dueAt identity is stale', async () => {
        let storageNow = Date.parse('2026-08-01T00:00:00.000Z');
        const store = new DurableTestStore(() => storageNow);
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const taskId = 'stale-timeout-callback';

        await engine.submitTask({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent', input: {},
            options: { taskRunTimeoutMs: 60_000 },
        });
        storageNow += 60_001;

        await expect(engine.handleTaskRunTimeout({
            tenantId: 'tenant_a', taskId, agentId: 'admission-agent',
            token: 'root-run-timeout',
            dueAt: new Date(storageNow + 60_000).toISOString(),
        })).resolves.toBe('stale');

        expect(driver.cancel).not.toHaveBeenCalled();
        const after = await store.getSessionSnapshot('tenant_a', taskId);
        expect((after?.snapshot.meta as Record<string, any>).taskLifecycle.state).toBe('active');
    });

    it('classifies identical concurrent submissions and rejects changed input', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const request = {
            tenantId: 'tenant_a', taskId: 'same-task', agentId: 'admission-agent', input: { a: 1 },
        } as const;
        const results = await Promise.all([engine.submitTask(request), engine.submitTask(request)]);
        expect(results.map((item) => item.status).sort()).toEqual(['accepted', 'duplicate_active']);
        expect(driver.enqueueStart).toHaveBeenCalledTimes(1);

        await expect(engine.submitTask({ ...request, input: { a: 2 } })).rejects.toMatchObject({
            code: 'TASK_SUBMISSION_CONFLICT',
        });
        await expect(engine.submitTask({ ...request, options: { maxTurns: 2 } })).rejects.toMatchObject({
            code: 'TASK_SUBMISSION_CONFLICT',
        });
    });

    it('persists schedule provenance and includes it in submission identity', async () => {
        const store = new DurableTestStore();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: admissionDriver() });
        const request = {
            tenantId: 'tenant_a', taskId: 'scheduled-root', agentId: 'admission-agent', input: { sweep: true },
            origin: {
                kind: 'schedule' as const,
                scheduleId: 'schedule-1',
                scheduleOccurrenceId: 'occurrence-1',
                scheduledFor: '2026-08-01T00:00:00.000Z',
            },
        };
        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'accepted' });
        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'duplicate_active' });
        await expect(engine.submitTask({
            ...request,
            origin: { ...request.origin, scheduleOccurrenceId: 'occurrence-2' },
        })).rejects.toMatchObject({ code: 'TASK_SUBMISSION_CONFLICT' });
        const stored = await store.getSessionSnapshot(request.tenantId, request.taskId);
        expect((stored?.snapshot.meta as Record<string, any>).taskSubmission.origin).toEqual(request.origin);
    });

    it('repairs a failed admission projection on an idempotent duplicate submission', async () => {
        const store = new ProjectionRepairStore();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: admissionDriver() });
        const request = {
            tenantId: 'tenant_a', taskId: 'projection-repair', agentId: 'admission-agent', input: {},
            origin: {
                kind: 'schedule' as const,
                scheduleId: 'schedule-1',
                scheduleOccurrenceId: 'occurrence-1',
            },
        };

        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'accepted' });
        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'duplicate_active' });
        expect(store.projectionUpsert).toHaveBeenCalledTimes(2);
        expect(store.projectionUpsert).toHaveBeenLastCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                originKind: 'schedule', scheduleId: 'schedule-1', scheduleOccurrenceId: 'occurrence-1',
            }),
        }));
    });

    it('exposes manifest-gated detached root admission and inherits schedule provenance', async () => {
        const store = new DurableTestStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const sourcePlugin = {
            ...loopPlugin,
            resolved: {
                ...loopPlugin.resolved,
                runtimeManifest: {
                    ...loopPlugin.resolved.runtimeManifest,
                    name: 'sweep-agent',
                    orchestration: { rootTaskSubmission: { allowAgents: ['target-agent'] } },
                },
                agentCard: { name: 'sweep-agent', version: '1.0.0' },
            },
        };
        const targetPlugin = {
            ...loopPlugin,
            resolved: {
                ...loopPlugin.resolved,
                runtimeManifest: { ...loopPlugin.resolved.runtimeManifest, name: 'target-agent' },
                agentCard: { name: 'target-agent', version: '1.0.0' },
            },
        };
        (PluginManager.findAgent as jest.Mock).mockImplementation((agentId: unknown) =>
            agentId === 'sweep-agent' ? sourcePlugin : agentId === 'target-agent' ? targetPlugin : undefined
        );
        await engine.submitTask({
            tenantId: 'tenant_a', taskId: 'sweep-root', agentId: 'sweep-agent', input: {},
            origin: { kind: 'schedule', scheduleId: 'schedule-1', scheduleOccurrenceId: 'occurrence-1' },
        });
        const ctx = (engine as any).createContext(
            { id: 'sweep-root', input: {} },
            { tenantId: 'tenant_a', agentId: 'sweep-agent' },
        );
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId: 'tenant_a', sessionId: 'sweep-root', agentId: 'sweep-agent', flushMentalState: async () => undefined,
        });
        await expect(ctx.tasks.submit('target-agent', { sourceId: 'source-1' }, {
            taskId: 'coordinator-root',
            maxTurns: 20,
            taskRunTimeoutMs: 32 * 60_000,
        }))
            .resolves.toEqual({ taskId: 'coordinator-root', status: 'accepted' });
        await expect(ctx.tasks.submit('other-agent', {}, { taskId: 'forbidden-root' }))
            .rejects.toMatchObject({ name: 'ROOT_TASK_SUBMISSION_TARGET_NOT_ALLOWED' });

        const submitted = await store.getSessionSnapshot('tenant_a', 'coordinator-root');
        const meta = submitted?.snapshot.meta as Record<string, any>;
        expect(meta.taskSubmission.origin).toEqual({
            kind: 'agent',
            scheduleId: 'schedule-1',
            scheduleOccurrenceId: 'occurrence-1',
            submittedByTaskId: 'sweep-root',
        });
        expect(meta.taskSubmission.options).toEqual({
            maxTurns: 20,
            taskRunTimeoutMs: 32 * 60_000,
        });
        expect(meta.rootRunDeadline).toMatchObject({
            timeoutMs: 32 * 60_000,
            source: 'task_submission',
        });
        expect(meta.taskLifecycle).toMatchObject({
            taskId: 'coordinator-root', rootTaskId: 'coordinator-root', ancestorTaskIds: [],
        });
        expect(meta.taskLifecycle.parentTaskId).toBeUndefined();
    });

    it('classifies stored identity before current agent and runtime availability', async () => {
        const store = new DurableTestStore();
        const request = {
            tenantId: 'tenant_a', taskId: 'state-first', agentId: 'admission-agent', input: { a: 1 },
            options: { taskRunTimeoutMs: 60_000 },
        } as const;
        const initialDriver = admissionDriver();
        await new TaskEngine({ sessionStore: store, runtimeDriver: initialDriver }).submitTask(request);
        const originalFireAt = ((initialDriver.scheduleTimer as jest.Mock).mock.calls[0]![0] as {
            fireAt: string;
        }).fireAt;

        (PluginManager.findAgent as jest.Mock).mockReturnValue(undefined);
        const wrongSurface = admissionDriver();
        Object.assign(wrongSurface, {
            surface: 'hatchet' as const,
            taskAdmissionCapabilities: undefined,
        });
        const rebuilt = new TaskEngine({ sessionStore: store, runtimeDriver: wrongSurface });

        await expect(rebuilt.submitTask(request)).resolves.toEqual({
            taskId: request.taskId,
            status: 'duplicate_active',
        });
        expect(wrongSurface.enqueueStart).not.toHaveBeenCalled();
        expect(wrongSurface.scheduleTimer).toHaveBeenCalledWith(expect.objectContaining({
            fireAt: originalFireAt,
        }));
        await expect(rebuilt.submitTask({ ...request, input: { a: 2 } })).rejects.toMatchObject({
            code: 'TASK_SUBMISSION_CONFLICT',
        });
    });

    it('records the first generation-one claim and admission latency once', async () => {
        const store = new DurableTestStore();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: admissionDriver() });
        await engine.submitTask({
            tenantId: 'tenant_a', taskId: 'claim-observed', agentId: 'admission-agent', input: {},
        });
        const session = new SessionManager(store);
        const claimed = await requestTaskTurn({
            session,
            tenantId: 'tenant_a',
            taskId: 'claim-observed',
            agentId: 'admission-agent',
            ownerId: 'worker-a',
            requestKey: 'claim-observed:turn-request:1',
            recoveryGeneration: '1',
            runtimeSurface: 'in_process',
        });
        expect(claimed.result.disposition).toBe('acquired');
        const submission = (claimed.snapshot.meta as Record<string, unknown>).taskSubmission as Record<string, unknown>;
        expect(submission.firstClaimedAt).toEqual(expect.any(String));
        const duration = defaultMetricsRegistry.snapshot().durations.find((row) =>
            row.name === 'task_submission_admission_to_claim_ms'
        );
        expect(duration).toMatchObject({ count: 1, dimensions: { runtimeSurface: 'in_process' } });
    });

    it('reports and resets generation-one admission backlog gauges', () => {
        const row = {
            tenantId: 'tenant_a', sessionId: 'pending', agentId: 'admission-agent',
            updatedAt: '2026-07-31T00:00:10.000Z', createdAt: '2026-07-31T00:00:00.000Z',
            generation: '1', deliveryKey: 'pending:turn-request:1', runtimeSurface: 'hatchet' as const,
        };
        expect(observeTaskSubmissionBacklog([row], 'hatchet', Date.parse('2026-07-31T00:01:00.000Z')))
            .toEqual({ count: 1, oldestAgeMs: 60_000 });
        observeTaskSubmissionBacklog([], 'hatchet', Date.parse('2026-07-31T00:02:00.000Z'));
        const gauges = defaultMetricsRegistry.snapshot().gauges.filter((item) =>
            item.dimensions.runtimeSurface === 'hatchet'
        );
        expect(gauges).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'task_submission_pending_count', value: 0 }),
            expect.objectContaining({ name: 'task_submission_oldest_age_ms', value: 0 }),
        ]));
    });

    it('returns duplicate_terminal and isolates identical task IDs by tenant', async () => {
        const store = new DurableTestStore();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: admissionDriver() });
        const request = {
            tenantId: 'tenant_a', taskId: 'shared-task', agentId: 'admission-agent', input: { a: 1 },
        } as const;
        await engine.submitTask(request);
        const current = await store.getSessionSnapshot(request.tenantId, request.taskId);
        const snapshot = current!.snapshot;
        const meta = snapshot.meta as Record<string, unknown>;
        await store.writeSnapshotCAS({
            tenantId: request.tenantId,
            sessionId: request.taskId,
            agentId: request.agentId,
            expectedWmVersion: current!.wmVersion,
            snapshot: {
                ...snapshot,
                meta: {
                    ...meta,
                    taskLifecycle: {
                        taskId: request.taskId,
                        rootTaskId: request.taskId,
                        ancestorTaskIds: [],
                        state: 'completed',
                        changedAt: '2026-07-31T00:00:00.000Z',
                    },
                },
            },
        });

        await expect(engine.submitTask(request)).resolves.toEqual({
            taskId: request.taskId,
            status: 'duplicate_terminal',
        });
        await expect(engine.submitTask({ ...request, tenantId: 'tenant_b' })).resolves.toEqual({
            taskId: request.taskId,
            status: 'accepted',
        });
    });

    it('keeps a failed provider publication recoverable and returns accepted', async () => {
        const store = new DurableTestStore();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: admissionDriver({ publishError: new Error('provider unavailable') }),
        });
        await expect(engine.submitTask({
            tenantId: 'tenant_a', taskId: 'deferred-task', agentId: 'admission-agent', input: {},
        })).resolves.toEqual({ taskId: 'deferred-task', status: 'accepted' });
        const stored = await store.getSessionSnapshot('tenant_a', 'deferred-task');
        expect(readTaskTurnCoordinator(stored?.snapshot).dispatchIntent).toMatchObject({
            generation: '1',
            deliveryKey: 'deferred-task:turn-request:1',
        });
    });

    it('keeps provider-accepted work recoverable when enqueue acknowledgement fails', async () => {
        const store = new FailFirstEnqueueAckStore();
        const driver = admissionDriver();
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: driver });
        const request = {
            tenantId: 'tenant_a', taskId: 'ack-crash', agentId: 'admission-agent', input: {},
        } as const;

        await expect(engine.submitTask(request)).resolves.toEqual({
            taskId: request.taskId,
            status: 'accepted',
        });
        expect(driver.enqueueStart).toHaveBeenCalledTimes(1);
        const stored = await store.getSessionSnapshot(request.tenantId, request.taskId);
        expect(readTaskTurnCoordinator(stored?.snapshot).dispatchIntent).toMatchObject({
            generation: '1',
            deliveryKey: 'ack-crash:turn-request:1',
            runtimeSurface: 'in_process',
        });
        await expect(store.listRunnableTurnRequests({ limit: 100 })).resolves.toHaveLength(1);

        await expect(engine.submitTask(request)).resolves.toMatchObject({ status: 'duplicate_active' });
        expect(driver.enqueueStart).toHaveBeenCalledTimes(1);
    });

    it('fails closed for process-local stores and pre-existing tasks', async () => {
        const unsupported = new TaskEngine({
            sessionStore: new InMemorySessionManager(),
            runtimeDriver: admissionDriver(),
        });
        await expect(unsupported.submitTask({
            tenantId: 'tenant_a', taskId: 'unsupported', agentId: 'admission-agent', input: {},
        })).rejects.toMatchObject({ code: 'TASK_ADMISSION_UNAVAILABLE' });

        const store = new DurableTestStore();
        await store.writeSnapshotCAS({
            tenantId: 'tenant_a', sessionId: 'historical', agentId: 'admission-agent',
            expectedWmVersion: 0n, snapshot: { meta: { agentId: 'admission-agent' } },
        });
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver: admissionDriver() });
        await expect(engine.submitTask({
            tenantId: 'tenant_a', taskId: 'historical', agentId: 'admission-agent', input: {},
        })).rejects.toMatchObject({ code: 'TASK_SUBMISSION_STATE_INCOMPATIBLE' });
    });
});

describe('task submission canonical JSON', () => {
    it('preserves the historical timeout-free v1 digest', () => {
        expect(taskSubmissionRequestDigest({
            agentId: 'admission-agent',
            canonicalInput: '{}',
        })).toBe('f6a56b9290df05e36622fc229355041d9dc71fff0cd6fa6efa5f90a57eb473d7');
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TASK_RUN_TIMEOUT_MS + 1])(
        'rejects invalid taskRunTimeoutMs %p',
        (value) => {
            expect(() => normalizeTaskSubmissionRunTimeout(value)).toThrow(TaskSubmissionError);
        }
    );

    it('accepts the portable taskRunTimeoutMs boundaries and omission', () => {
        expect(normalizeTaskSubmissionRunTimeout(undefined)).toBeUndefined();
        expect(normalizeTaskSubmissionRunTimeout(1)).toBe(1);
        expect(normalizeTaskSubmissionRunTimeout(MAX_TASK_RUN_TIMEOUT_MS))
            .toBe(MAX_TASK_RUN_TIMEOUT_MS);
    });

    it.each([
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        () => undefined,
        Symbol('x'),
        new Date(),
        [, 1],
    ])('rejects non-durable input %#', (input) => {
        expect(() => canonicalizeTaskSubmissionInput(input)).toThrow(TaskSubmissionError);
    });

    it('rejects cycles and canonicalizes object key order', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => canonicalizeTaskSubmissionInput(cyclic)).toThrow(TaskSubmissionError);
        expect(canonicalizeTaskSubmissionInput({ z: 1, a: 2 }).canonical)
            .toBe('{"a":2,"z":1}');
    });
});
