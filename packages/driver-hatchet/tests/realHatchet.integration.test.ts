import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { SegmentResult, TurnExecutor } from '@a2arium/callagent-core/unstable';
import type { HatchetClient } from '../src/hatchetClient.js';
import type { TaskTaskDeps, TaskTaskInput, TaskTaskOutput } from '../src/tasks/task.js';
import type { DriverRunRecord } from '../src/driverRunsRepository.js';

const describeRealHatchet = process.env.CALLAGENT_TEST_REAL_HATCHET === '1'
    ? describe
    : describe.skip;

describeRealHatchet('single-protocol real Hatchet integration', () => {
    jest.setTimeout(120_000);

    let hatchet: HatchetClient;
    let rootTask: ReturnType<typeof import('../src/tasks/task.js').createTaskTask>;
    let createSegmentTask: typeof import('../src/tasks/segment.js').createSegmentTask;
    let createTaskStateTask: typeof import('../src/tasks/task.js').createTaskStateTask;
    let worker: Awaited<ReturnType<HatchetClient['worker']>> | undefined;
    let workerStart: Promise<void> | undefined;
    let hatchetInitialized = false;
    let taskDeps: TaskTaskDeps;
    const driverRecords = new Map<string, DriverRunRecord & { providerRunId: string }>();
    const segmentGates = new Map<string, Promise<void>>();
    const snapshots = new Map<string, { snapshot: Record<string, unknown>; wmVersion: bigint; agentId: string }>();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let protocolNames: ReturnType<typeof import('../src/tasks/task.js').createNamespacedTaskProtocolNames>;

    const turnExecutor = {
        runSegment: jest.fn(async (input: {
            tenantId: string;
            taskId: string;
            agentId?: string;
        }): Promise<SegmentResult> => {
            await segmentGates.get(input.taskId);
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
        worker = await hatchet.worker(`callagent-real-hatchet-${suffix}`, {
            slots: 8,
            durableSlots: 4,
            handleKill: false,
        });
        await worker.registerWorkflows([
            createTaskStateTask(hatchet, taskDeps),
            createSegmentTask(hatchet, { turnExecutor, driverRuns: driverRuns as never }, { name: protocolNames.segment }),
            rootTask,
        ]);
        workerStart = worker.start();
        await worker.waitUntilReady(30_000);
    }

    async function stopWorker(): Promise<void> {
        const current = worker;
        const started = workerStart;
        worker = undefined;
        workerStart = undefined;
        if (current !== undefined) await current.stop();
        if (started !== undefined) await started;
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
                throw new Error(`Hatchet run ${runId} ended as ${details.run.status}: ${details.run.errorMessage ?? 'no error'}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`Timed out waiting for Hatchet run ${runId}`);
    }

    beforeAll(async () => {
        // Jest's ESM linker cannot safely link the shared core graph through
        // concurrent dynamic imports. Production uses the native Node loader;
        // keep this integration harness deterministic by linking sequentially.
        const hatchetClientModule = await import('../src/hatchetClient.js');
        const segmentModule = await import('../src/tasks/segment.js');
        const taskModule = await import('../src/tasks/task.js');
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
        await startWorker();
    });

    afterAll(async () => {
        await stopWorker();
        if (hatchetInitialized) await hatchet.durableListener.stop();
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

    it('projects a cache hit through task-state without creating a segment turn', async () => {
        const taskInput = {
            ...input(`cache-${suffix}`),
            input: { value: 'cache-hit' },
            cache: { enabled: true },
        };
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
            }),
        }));
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
