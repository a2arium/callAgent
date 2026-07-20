import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { SegmentResult, TurnExecutor } from '@a2arium/callagent-core/unstable';
import type { HatchetClient } from '../src/hatchetClient.js';
import type { TaskTaskInput, TaskTaskOutput } from '../src/tasks/task.js';

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
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const turnExecutor = {
        runSegment: jest.fn(async (input: {
            tenantId: string;
            taskId: string;
            agentId?: string;
        }): Promise<SegmentResult> => ({
            tenantId: input.tenantId,
            taskId: input.taskId,
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            boundary: { kind: 'complete', result: { ok: true, taskId: input.taskId } },
            taskStatus: 'completed',
            turnDisposition: 'executed',
        })),
    } as unknown as TurnExecutor;

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
            createTaskStateTask(hatchet, {}),
            createSegmentTask(hatchet, { turnExecutor }),
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
        const { createTaskTask } = taskModule;
        hatchet = createHatchetClient();
        hatchetInitialized = true;
        rootTask = createTaskTask(hatchet, {});
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
    });
});
