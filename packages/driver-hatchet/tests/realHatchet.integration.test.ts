import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { SegmentResult, TurnExecutor } from '@a2arium/callagent-core/unstable';
import type { HatchetClient } from '../src/hatchetClient.js';
import type { TaskTaskDeps, TaskTaskInput, TaskTaskOutput } from '../src/tasks/task.js';
import type { DriverRunRecord } from '../src/driverRunsRepository.js';
import type { ScheduleDispatchInput } from '../src/tasks/scheduleDispatch.js';

const describeRealHatchet = process.env.CALLAGENT_TEST_REAL_HATCHET === '1'
    ? describe
    : describe.skip;

describeRealHatchet('single-protocol real Hatchet integration', () => {
    jest.setTimeout(120_000);

    let hatchet: HatchetClient;
    let rootTask: ReturnType<typeof import('../src/tasks/task.js').createTaskTask>;
    let createSegmentTask: typeof import('../src/tasks/segment.js').createSegmentTask;
    let createTaskStateTask: typeof import('../src/tasks/task.js').createTaskStateTask;
    let scheduleDispatchTask: ReturnType<typeof import('../src/tasks/scheduleDispatch.js').createScheduleDispatchTask>;
    let timerFireTask: ReturnType<typeof import('../src/tasks/timerFire.js').createTimerFireTask>;
    let timerReconciler: InstanceType<typeof import('../src/timerReconciler.js').TimerReconciler>;
    let sqlStore: InstanceType<typeof import('@a2arium/callagent-memory-sql').WorkingMemorySessionStore>;
    let sqlPrisma: ReturnType<InstanceType<typeof import('@a2arium/callagent-memory-sql').WorkingMemorySessionStore>['getPrismaClient']>;
    let scheduleMetadata: typeof import('../src/tasks/scheduleDispatch.js').scheduleMetadata;
    let worker: Awaited<ReturnType<HatchetClient['worker']>> | undefined;
    let workerStart: Promise<void> | undefined;
    let workerGeneration = 0;
    let hatchetInitialized = false;
    let taskDeps: TaskTaskDeps;
    const driverRecords = new Map<string, DriverRunRecord & { providerRunId: string }>();
    const segmentGates = new Map<string, Promise<void>>();
    const segmentExecutors = new Map<string, (input: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        idempotencyKey: string;
        runtimeSurface?: 'hatchet';
        recoveryGeneration?: string;
        wake: { trigger: 'start'; input: unknown };
    }) => Promise<SegmentResult>>();
    const snapshots = new Map<string, { snapshot: Record<string, unknown>; wmVersion: bigint; agentId: string }>();
    const scheduleSubmissions: Array<Record<string, any>> = [];
    const taskRunTimeoutHandlers = new Map<string, (params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        token: string;
        dueAt: string;
        payload?: unknown;
    }) => Promise<'canceled' | 'terminal' | 'not_due' | 'stale' | 'missing'>>();
    const timerReconcileTaskIds = new Set<string>();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let protocolNames: ReturnType<typeof import('../src/tasks/task.js').createNamespacedTaskProtocolNames>;

    const turnExecutor = {
        runSegment: jest.fn(async (input: {
            tenantId: string;
            taskId: string;
            agentId?: string;
            idempotencyKey: string;
            runtimeSurface?: 'hatchet';
            recoveryGeneration?: string;
            wake: { trigger: 'start'; input: unknown };
        }): Promise<SegmentResult> => {
            await segmentGates.get(input.taskId);
            const execute = segmentExecutors.get(input.taskId);
            if (execute !== undefined) return execute(input);
            return ({
            tenantId: input.tenantId,
            taskId: input.taskId,
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            boundary: { kind: 'complete', result: { ok: true, taskId: input.taskId } },
            taskStatus: 'completed',
            turnDisposition: 'executed',
            turnClaim: {
                claimId: `claim-${input.taskId}`,
                fence: '1',
                claimedGeneration: '1',
                turnSeq: 1,
            },
        });
        }),
    } as unknown as TurnExecutor;

    const driverRuns = {
        upsertByProviderRunId: jest.fn(async (record: DriverRunRecord & { providerRunId: string }) => {
            driverRecords.set(record.providerRunId, {
                ...driverRecords.get(record.providerRunId),
                ...record,
            });
        }),
        finalizeRootRun: jest.fn(async (record: { tenantId: string; taskId: string; status: string }) => {
            for (const [providerRunId, existing] of driverRecords) {
                if (existing.tenantId === record.tenantId && existing.taskId === record.taskId) {
                    driverRecords.set(providerRunId, { ...existing, status: record.status });
                }
            }
        }),
    };

    function input(taskId: string): TaskTaskInput {
        const tenantId = `real-hatchet-${suffix}`;
        const tenantTaskKey = `${tenantId.length}:${tenantId}:${taskId.length}:${taskId}`;
        return {
            tenantId,
            taskId,
            rootTaskId: taskId,
            agentId: 'real-hatchet-test-agent',
            input: { value: taskId },
            idempotencyKey: `${taskId}:start`,
            tenantTaskKey,
            rootRunKey: `${tenantTaskKey}:root:1`,
        };
    }

    async function startWorker(): Promise<void> {
        workerGeneration += 1;
        worker = await hatchet.worker(`callagent-real-hatchet-${suffix}-${workerGeneration}`, {
            slots: 8,
            durableSlots: 4,
            handleKill: false,
        });
        await worker.registerWorkflows([
            createTaskStateTask(hatchet, taskDeps),
            createSegmentTask(hatchet, { turnExecutor, driverRuns: driverRuns as never }, { name: protocolNames.segment }),
            rootTask,
            scheduleDispatchTask,
            timerFireTask,
        ]);
        workerStart = worker.start();
        await worker.waitUntilReady(30_000);
    }

    async function stopWorker(): Promise<void> {
        const current = worker;
        const started = workerStart;
        const workerId = current?._internal.workerId;
        worker = undefined;
        workerStart = undefined;
        if (current !== undefined) {
            const internal = current._internal as unknown as {
                futures: Record<string, unknown>;
                cleanupRun: (actionKey: string) => void;
            };
            const drainDeadline = Date.now() + 2_000;
            while (Object.keys(internal.futures).length > 0 && Date.now() < drainDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            // Hatchet 1.24 can retain already-provider-terminal futures after
            // durable cancellation. Tests have awaited provider terminality by
            // this point, so remove stale bookkeeping before graceful stop.
            for (const actionKey of Object.keys(internal.futures)) {
                internal.cleanupRun(actionKey);
            }
            await current.stop();
        }
        if (started !== undefined) await started;
        if (workerId !== undefined) {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                const stopped = await hatchet.workers.get(workerId);
                if (stopped.status !== 'ACTIVE') return;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`Hatchet worker ${workerId} remained active after stop`);
        }
    }

    async function waitForOutput(
        ref: { readonly runId: Promise<string> }
    ): Promise<TaskTaskOutput> {
        const runId = await ref.runId;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            let details: Awaited<ReturnType<HatchetClient['runs']['get']>>;
            try {
                details = await hatchet.runs.get(runId);
            } catch (error) {
                const status = (error as { response?: { status?: number } }).response?.status;
                if (status !== 404) throw error;
                await new Promise((resolve) => setTimeout(resolve, 250));
                continue;
            }
            if (details.run.status === 'COMPLETED') {
                return details.run.output as TaskTaskOutput;
            }
            if (details.run.status === 'FAILED' || details.run.status === 'CANCELLED') {
                if (
                    details.run.status === 'FAILED'
                    && details.run.errorMessage?.startsWith('Could not send task to worker')
                ) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    continue;
                }
                throw new Error(`Hatchet run ${runId} ended as ${details.run.status}: ${details.run.errorMessage ?? 'no error'}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`Timed out waiting for Hatchet run ${runId}`);
    }

    async function waitForRunTerminal(runId: string, timeoutMs = 30_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        let status = 'UNKNOWN';
        while (Date.now() < deadline) {
            const details = await hatchet.runs.get(runId);
            status = details.run.status;
            if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
                return status;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Hatchet run ${runId} remained ${status} after ${timeoutMs}ms`);
    }

    beforeAll(async () => {
        // Jest's ESM linker cannot safely link the shared core graph through
        // concurrent dynamic imports. Production uses the native Node loader;
        // keep this integration harness deterministic by linking sequentially.
        const hatchetClientModule = await import('../src/hatchetClient.js');
        const segmentModule = await import('../src/tasks/segment.js');
        const taskModule = await import('../src/tasks/task.js');
        const scheduleModule = await import('../src/tasks/scheduleDispatch.js');
        const timerFireModule = await import('../src/tasks/timerFire.js');
        const timerReconcilerModule = await import('../src/timerReconciler.js');
        const memorySqlModule = await import('@a2arium/callagent-memory-sql');
        const coreUnstable = await import('@a2arium/callagent-core/unstable');
        scheduleMetadata = scheduleModule.scheduleMetadata;
        createSegmentTask = segmentModule.createSegmentTask;
        createTaskStateTask = taskModule.createTaskStateTask;
        const { createHatchetClient } = hatchetClientModule;
        const { createNamespacedTaskProtocolNames, createTaskTask } = taskModule;
        hatchet = createHatchetClient();
        hatchetInitialized = true;
        protocolNames = createNamespacedTaskProtocolNames(`aplret.test.${suffix}`);
        taskDeps = {
            protocolNames,
            driverRuns: driverRuns as never,
            sessionManager: {
                load: async (_tenantId, sessionId) => snapshots.get(sessionId) ?? null,
                saveSnapshot: async (params) => {
                    const current = snapshots.get(params.sessionId);
                    expect(current?.wmVersion ?? BigInt(0)).toBe(params.expectedWmVersion);
                    const saved = {
                        snapshot: params.snapshot,
                        wmVersion: params.expectedWmVersion + BigInt(1),
                        agentId: params.agentId,
                    };
                    snapshots.set(params.sessionId, saved);
                    return { newVersion: saved.wmVersion };
                },
                appendEvent: async () => ({ eventId: 'unused', seq: 1 }),
            },
            agentResultCache: {
                getCachedResult: async (_agentId, value) =>
                    (value as { value?: unknown }).value === 'cache-hit'
                        ? { ok: true, source: 'real-hatchet-cache' }
                        : null,
                setCachedResult: async () => undefined,
            },
        };
        rootTask = createTaskTask(hatchet, taskDeps, protocolNames.task, { protocolNames });
        scheduleDispatchTask = scheduleModule.createScheduleDispatchTask(hatchet, {
            submitTask: async (request) => {
                scheduleSubmissions.push(request);
                return { taskId: request.taskId, status: 'accepted' };
            },
        });
        sqlStore = new memorySqlModule.WorkingMemorySessionStore();
        await sqlStore.connect();
        sqlPrisma = sqlStore.getPrismaClient();
        const runtimeTimers = new coreUnstable.RuntimeTimerRepository(sqlPrisma as never);
        timerFireTask = timerFireModule.createTimerFireTask(hatchet, {
            runtimeTimers,
            onTaskRunTimeout: async (params) => {
                const handler = taskRunTimeoutHandlers.get(params.taskId);
                if (handler === undefined) throw new Error('REAL_HATCHET_TIMEOUT_HANDLER_MISSING');
                return handler(params);
            },
        });
        timerReconciler = new timerReconcilerModule.TimerReconciler(
            {
                readStorageNow: (now?: Date) => runtimeTimers.readStorageNow(now),
                listDue: async (params: { now?: Date; take: number }) =>
                    (await runtimeTimers.listDue({ ...params, take: 1_000 }))
                        .filter((timer) => timerReconcileTaskIds.has(timer.taskId)),
                attachProviderRun: (params: Parameters<typeof runtimeTimers.attachProviderRun>[0]) =>
                    runtimeTimers.attachProviderRun(params),
            } as never,
            timerFireTask,
            { batchSize: 100 }
        );
        await startWorker();
    });

    afterAll(async () => {
        timerReconciler?.stop();
        await stopWorker();
        if (hatchetInitialized) await hatchet.durableListener.stop();
        await sqlPrisma?.$disconnect();
    });

    it('executes the sole root, segment, and task-state workflow protocol', async () => {
        const taskInput = input(`complete-${suffix}`);
        const output = await waitForOutput(await rootTask.runNoWait(taskInput));

        expect(output.boundary).toEqual({
            kind: 'complete',
            result: { ok: true, taskId: taskInput.taskId },
        });
        expect(output.turnDisposition).toBe('executed');
        expect(turnExecutor.runSegment).toHaveBeenCalledWith(expect.objectContaining({
            taskId: taskInput.taskId,
            runtimeSurface: 'hatchet',
        }));
    });

    it('retains an accepted durable root while no worker is available and resumes after restart', async () => {
        await stopWorker();
        const taskInput = input(`restart-${suffix}`);
        const ref = await rootTask.runNoWait(taskInput);

        await startWorker();
        const output = await waitForOutput(ref);

        expect(output.boundary).toEqual({
            kind: 'complete',
            result: { ok: true, taskId: taskInput.taskId },
        });
        expect(output.turnDisposition).toBe('executed');
        expect(turnExecutor.runSegment).toHaveBeenCalledWith(expect.objectContaining({
            taskId: taskInput.taskId,
            runtimeSurface: 'hatchet',
        }));
    });

    it('cancels an already-claimed SQL-backed root through real Hatchet after engine reconstruction', async () => {
        const { TaskEngine, PluginManager } = await import('@a2arium/callagent-core');
        const { RuntimeTimerRepository } = await import('@a2arium/callagent-core/unstable');
        const { HatchetRuntimeDriver } = await import('../src/hatchetRuntimeDriver.js');
        const taskId = `deadline-${suffix}`;
        const tenantId = `real-hatchet-${suffix}`;
        const previousOutboxPublisher = process.env.DISABLE_OUTBOX_PUBLISHER;
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        const runtimeTimers = new RuntimeTimerRepository(sqlPrisma as never);
        const pluginSpy = jest.spyOn(PluginManager, 'findAgent').mockReturnValue({
            resolved: {
                runtimeManifest: {
                    name: 'real-hatchet-test-agent',
                    version: '1.0.0',
                    runMode: 'loop',
                    budgets: { maxTurns: 5 },
                },
                runtimeManifestSource: 'real-hatchet-test',
                agentCard: { name: 'real-hatchet-test-agent', version: '1.0.0' },
                agentCardSource: 'real-hatchet-test',
            },
        } as never);
        let engine: InstanceType<typeof TaskEngine>;
        let releaseTurn!: () => void;
        let signalTurnStarted!: () => void;
        let signalSegmentFinished!: () => void;
        const turnRelease = new Promise<void>((resolve) => { releaseTurn = resolve; });
        const turnStarted = new Promise<void>((resolve) => { signalTurnStarted = resolve; });
        const segmentFinished = new Promise<void>((resolve) => { signalSegmentFinished = resolve; });
        let runTurnSpy: ReturnType<typeof jest.spyOn> | undefined;
        try {
            const createEngine = () => new TaskEngine({
                sessionStore: sqlStore,
                runtimeDriverFactory: (stack) => new HatchetRuntimeDriver(
                    stack.runtimeDriver,
                    {
                        runNoWait: jest.fn(async () => ({
                            runId: Promise.resolve(`outbox-${taskId}-${Date.now()}`),
                        })),
                    } as never,
                    undefined,
                    undefined,
                    rootTask,
                    (hatchet as unknown as { events: { push: Function } }).events as never,
                    undefined,
                    runtimeTimers,
                    timerFireTask
                ),
            });
            engine = createEngine();
            runTurnSpy = jest.spyOn(
                (engine as unknown as { turnRunner: { runTurn: (...args: never[]) => Promise<unknown> } }).turnRunner,
                'runTurn'
            ).mockImplementation(async () => {
                signalTurnStarted();
                await turnRelease;
                return {
                    id: taskId,
                    input: { bounded: true },
                    status: { state: 'completed', timestamp: new Date().toISOString() },
                };
            });
            segmentExecutors.set(taskId, async (segmentInput) => {
                try {
                    return await engine.getCompositionTurnExecutor().runSegment(segmentInput);
                } finally {
                    signalSegmentFinished();
                }
            });
            taskRunTimeoutHandlers.set(taskId, (params) => engine.handleTaskRunTimeout(params));
            timerReconcileTaskIds.add(taskId);

            await expect(engine.submitTask({
                tenantId,
                taskId,
                agentId: 'real-hatchet-test-agent',
                input: { bounded: true },
                options: { taskRunTimeoutMs: 10_000 },
            })).resolves.toEqual({ taskId, status: 'accepted' });

            await Promise.race([
                turnStarted,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('Hatchet segment did not claim the turn before timeout')),
                    30_000
                )),
            ]);
            let stored = await sqlStore.getSessionSnapshot(tenantId, taskId);
            expect((stored?.snapshot.meta as Record<string, any>).taskSubmission.firstClaimedAt)
                .toEqual(expect.any(String));
            expect((stored?.snapshot.meta as Record<string, any>).turnCoordinator.active)
                .toEqual(expect.objectContaining({ phase: 'executing' }));

            // The timeout is durable in PostgreSQL before framework process
            // reconstruction; the new engine owns the eventual Hatchet fire.
            const timerBeforeRestart = await sqlPrisma.runtimeTimer.findMany({
                where: { tenantId, taskId, kind: 'task_run_timeout' },
            });
            expect(timerBeforeRestart).toHaveLength(1);
            expect(timerBeforeRestart[0]!.status).toBe('scheduled');

            const recoveredEngine = createEngine();
            taskRunTimeoutHandlers.set(
                taskId,
                (params) => recoveredEngine.handleTaskRunTimeout(params)
            );
            const dueAtMs = timerBeforeRestart[0]!.dueAt.getTime();
            const waitMs = Math.max(0, dueAtMs - Date.now() + 150);
            if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
            await expect(timerReconciler.scanOnce()).resolves.toBe(1);

            const terminalDeadline = Date.now() + 30_000;
            while (Date.now() < terminalDeadline) {
                stored = await sqlStore.getSessionSnapshot(tenantId, taskId);
                if ((stored?.snapshot.meta as Record<string, any> | undefined)?.taskLifecycle?.state === 'canceled') {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            expect((stored?.snapshot.meta as Record<string, any>).taskLifecycle).toMatchObject({
                state: 'canceled',
                reason: 'active_run_timeout',
            });
            expect((stored?.snapshot.meta as Record<string, any>).taskTerminal.status).toMatchObject({
                state: 'canceled',
                metadata: expect.objectContaining({
                    code: 'TASK_RUN_TIMEOUT',
                    timeoutMs: 10_000,
                }),
            });
            expect(await sqlPrisma.wMEvent.count({
                where: { tenantId, sessionId: taskId, type: 'task.canceled' },
            })).toBe(1);

            releaseTurn();
            await Promise.race([
                segmentFinished,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('Late segment did not converge after timeout cancellation')),
                    30_000
                )),
            ]);
            const lateDeadline = Date.now() + 30_000;
            while (Date.now() < lateDeadline) {
                const timer = await sqlPrisma.runtimeTimer.findFirst({
                    where: { tenantId, taskId, kind: 'task_run_timeout' },
                });
                if (timer?.status === 'fired' || timer?.status === 'canceled') break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            stored = await sqlStore.getSessionSnapshot(tenantId, taskId);
            expect((stored?.snapshot.meta as Record<string, any>).taskTerminal.status).toMatchObject({
                state: 'canceled',
                metadata: expect.objectContaining({ code: 'TASK_RUN_TIMEOUT' }),
            });
            expect(await sqlPrisma.wMEvent.count({
                where: { tenantId, sessionId: taskId, type: 'task.completed' },
            })).toBe(0);
            expect(await sqlPrisma.runtimeTimer.count({
                where: {
                    tenantId,
                    taskId,
                    kind: 'task_run_timeout',
                    status: { in: ['fired', 'canceled'] },
                    providerRunId: { not: null },
                },
            })).toBe(1);
            const firedTimer = await sqlPrisma.runtimeTimer.findFirst({
                where: { tenantId, taskId, kind: 'task_run_timeout' },
            });
            expect(firedTimer?.providerRunId).toEqual(expect.any(String));
            await expect(waitForRunTerminal(firedTimer!.providerRunId!)).resolves.toBe('COMPLETED');
        } finally {
            releaseTurn?.();
            segmentExecutors.delete(taskId);
            taskRunTimeoutHandlers.delete(taskId);
            timerReconcileTaskIds.delete(taskId);
            runTurnSpy?.mockRestore();
            pluginSpy.mockRestore();
            if (previousOutboxPublisher === undefined) {
                delete process.env.DISABLE_OUTBOX_PUBLISHER;
            } else {
                process.env.DISABLE_OUTBOX_PUBLISHER = previousOutboxPublisher;
            }
        }
    });

    it('fires a real one-time schedule with authoritative occurrence provenance', async () => {
        const scheduleId = `schedule-${suffix}`;
        const triggerAt = new Date(Date.now() + 2_000);
        const scheduleInput: ScheduleDispatchInput = {
            schemaVersion: 1,
            scheduleId,
            revision: 1,
            kind: 'once',
            tenantId: `real-hatchet-${suffix}`,
            agentId: 'real-hatchet-test-agent',
            displayName: 'Real Hatchet occurrence-time check',
            input: { source: 'real-schedule' },
            // Deliberately stale: the worker must replace this with the actual
            // provider occurrence timestamp fetched by workflowRunId.
            scheduledFor: '2026-01-01T00:00:00.000Z',
        };
        const scheduled = await scheduleDispatchTask.schedule(triggerAt, scheduleInput, {
            additionalMetadata: scheduleMetadata(scheduleInput),
        });
        try {
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline && !scheduleSubmissions.some((row) => row.origin?.scheduleId === scheduleId)) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            const submitted = scheduleSubmissions.find((row) => row.origin?.scheduleId === scheduleId);
            expect(submitted).toBeDefined();
            expect(submitted).toMatchObject({
                tenantId: scheduleInput.tenantId,
                agentId: scheduleInput.agentId,
                input: scheduleInput.input,
                origin: {
                    kind: 'schedule',
                    scheduleId,
                    scheduleOccurrenceId: expect.any(String),
                    scheduledFor: expect.any(String),
                },
            });
            expect(submitted!.origin.scheduledFor).not.toBe(scheduleInput.scheduledFor);
            expect(Math.abs(Date.parse(submitted!.origin.scheduledFor) - triggerAt.getTime())).toBeLessThan(15_000);
        } finally {
            await hatchet.scheduled.delete(scheduled).catch(() => undefined);
        }
    });

    it('projects a cache hit through task-state without creating a segment turn', async () => {
        const deliveryKey = `cache-${suffix}:turn-request:1`;
        const taskInput = {
            ...input(`cache-${suffix}`),
            input: { value: 'cache-hit' },
            cache: { enabled: true },
            idempotencyKey: deliveryKey,
            recoveryGeneration: '1',
            recoveryDeliveryKey: deliveryKey,
        };
        snapshots.set(taskInput.taskId, {
            wmVersion: BigInt(1),
            agentId: taskInput.agentId!,
            snapshot: {
                meta: {
                    agentId: taskInput.agentId,
                    taskLifecycle: {
                        taskId: taskInput.taskId, rootTaskId: taskInput.taskId,
                        ancestorTaskIds: [], state: 'active',
                    },
                    turnCoordinator: {
                        schemaVersion: 1, runtimeSurface: 'hatchet', nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '1', completedGeneration: '0',
                        dispatchIntent: {
                            generation: '1', deliveryKey, runtimeSurface: 'hatchet',
                            createdAt: '2026-07-31T00:00:00.000Z',
                        },
                    },
                },
            },
        });
        const output = await waitForOutput(await rootTask.runNoWait(taskInput));

        expect(output.boundary).toEqual({
            kind: 'complete',
            result: { ok: true, source: 'real-hatchet-cache' },
        });
        expect(output.executionMetadata).toEqual({ origin: 'cache' });
        expect(turnExecutor.runSegment).not.toHaveBeenCalledWith(expect.objectContaining({
            taskId: taskInput.taskId,
        }));
        expect(snapshots.get(taskInput.taskId)?.snapshot).toEqual(expect.objectContaining({
            meta: expect.objectContaining({
                taskTerminal: expect.objectContaining({
                    state: 'completed',
                    status: expect.objectContaining({
                        metadata: expect.objectContaining({ origin: 'cache', source: 'cache' }),
                    }),
                }),
                turnCoordinator: expect.objectContaining({
                    requestedGeneration: '1', completedGeneration: '1',
                }),
            }),
        }));
        expect((snapshots.get(taskInput.taskId)?.snapshot.meta as any)?.turnCoordinator?.dispatchIntent)
            .toBeUndefined();
    });

    it('keeps one active segment attempt and preserves nested ancestry through completion', async () => {
        const taskId = `nested-${suffix}`;
        let releaseSegment!: () => void;
        segmentGates.set(taskId, new Promise<void>((resolve) => { releaseSegment = resolve; }));
        const taskInput = {
            ...input(taskId),
            rootTaskId: `root-${suffix}`,
            parentTaskId: `parent-${suffix}`,
        };
        const ref = await rootTask.runNoWait(taskInput);
        const deadline = Date.now() + 30_000;
        let running: Array<DriverRunRecord & { providerRunId: string }> = [];
        while (Date.now() < deadline) {
            running = [...driverRecords.values()].filter((record) =>
                record.taskId === taskId && record.operation === 'turn.segment' && record.status === 'running'
            );
            if (running.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(running).toHaveLength(1);
        expect(running[0]).toEqual(expect.objectContaining({
            rootTaskId: taskInput.rootTaskId,
            parentTaskId: taskInput.parentTaskId,
        }));

        releaseSegment();
        segmentGates.delete(taskId);
        await waitForOutput(ref);
        const completed = [...driverRecords.values()].filter((record) =>
            record.taskId === taskId && record.operation === 'turn.segment'
        );
        expect(completed).toHaveLength(1);
        expect(completed[0]).toEqual(expect.objectContaining({
            rootTaskId: taskInput.rootTaskId,
            parentTaskId: taskInput.parentTaskId,
            claimId: `claim-${taskId}`,
            status: 'completed',
        }));
    });
});
