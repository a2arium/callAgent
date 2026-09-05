import { describe, expect, it, jest } from '@jest/globals';
import {
    resolveAgentHatchetExecutionTimeout,
    resolveHatchetExecutionTimeout,
    resolveSharedSegmentHatchetExecutionTimeout,
} from '../src/taskTimeouts.js';
import { createSegmentTask, SEGMENT_TASK_NAME } from '../src/tasks/segment.js';
import { executeSegmentTask } from '../src/tasks/segment.js';
import {
    createNamespacedTaskProtocolNames,
    createTaskStateTask,
    createTaskTask,
    DEFAULT_TASK_PROTOCOL_NAMES,
    executeTaskStateTask,
    executeTaskTask,
    TASK_STATE_TASK_NAME,
    TASK_TASK_NAME,
} from '../src/tasks/task.js';
import { TaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1/task.js';

function createMemorySessions(initial: Record<string, Record<string, unknown>>) {
    const snapshots = new Map(Object.entries(initial));
    const versions = new Map(Object.keys(initial).map((key) => [key, BigInt(1)]));
    const appendEvent = jest.fn(async () => ({ eventId: 'event-1', seq: 1 }));
    const sessionManager = {
        load: jest.fn(async (_tenantId: string, sessionId: string) => {
            const snapshot = snapshots.get(sessionId);
            return snapshot === undefined ? null : {
                snapshot,
                wmVersion: versions.get(sessionId) ?? BigInt(0),
                agentId: (snapshot.meta as { agentId?: string } | undefined)?.agentId,
            };
        }),
        saveSnapshot: jest.fn(async (params: {
            sessionId: string;
            expectedWmVersion: bigint;
            snapshot: Record<string, unknown>;
        }) => {
            const currentVersion = versions.get(params.sessionId) ?? BigInt(0);
            if (currentVersion !== params.expectedWmVersion) {
                throw new Error('unexpected test version conflict');
            }
            const nextVersion = currentVersion + BigInt(1);
            snapshots.set(params.sessionId, params.snapshot);
            versions.set(params.sessionId, nextVersion);
            return { snapshot: params.snapshot, newVersion: nextVersion };
        }),
        appendEvent,
    };
    return { snapshots, versions, sessionManager, appendEvent };
}

describe('executeTaskTask', () => {
    it('derives Hatchet execution timeout from latency budget plus grace', () => {
        expect(resolveHatchetExecutionTimeout({ latencyMs: 300_000 })).toBe('6m');
        expect(resolveHatchetExecutionTimeout({ latencyMs: 600_000 })).toBe('11m');
    });

    it('falls back to the default Hatchet execution timeout without latency budget', () => {
        expect(resolveHatchetExecutionTimeout({})).toBe('30m');
        expect(resolveHatchetExecutionTimeout()).toBe('30m');
    });

    it('derives agent and shared segment timeouts from registered agent budgets', () => {
        const shortBudgetAgent = {
            resolved: { runtimeManifest: { budgets: { latencyMs: 300_000 } } },
        };
        const fallbackAgent = {
            resolved: { runtimeManifest: { budgets: { maxTurns: 10 } } },
        };

        expect(resolveAgentHatchetExecutionTimeout(shortBudgetAgent)).toBe('6m');
        expect(resolveSharedSegmentHatchetExecutionTimeout([
            shortBudgetAgent,
            fallbackAgent,
        ])).toBe('30m');
    });

    it('preserves a four-hour importer budget for shared Hatchet workflows', () => {
        const importer = {
            resolved: { runtimeManifest: { budgets: { latencyMs: 4 * 60 * 60 * 1000 } } },
        };

        expect(resolveSharedSegmentHatchetExecutionTimeout([importer])).toBe('241m');
    });

    it('declares segment tasks with an explicit execution timeout', () => {
        const task = jest.fn((options: unknown) => options);

        createSegmentTask({ task } as never, { turnExecutor: {} as never });

        expect(task).toHaveBeenCalledWith(expect.objectContaining({
            executionTimeout: '30m',
            retries: 3,
        }));
    });

    it('allows segment task execution timeout override', () => {
        const task = jest.fn((options: unknown) => options);

        createSegmentTask(
            { task } as never,
            { turnExecutor: {} as never },
            { executionTimeout: '6m' }
        );

        expect(task).toHaveBeenCalledWith(expect.objectContaining({
            executionTimeout: '6m',
            retries: 3,
        }));
    });

    it('classifies terminal lifecycle registration stops as non-retryable', async () => {
        const lifecycleError = new TaskLifecycleTerminalError({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            state: 'detached',
            reason: 'child_timeout',
            effectKind: 'tool',
        });
        const turnExecutor = {
            runSegment: jest.fn(async () => { throw lifecycleError; }),
        };
        const ctx = {
            workflowRunId: () => 'workflow-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 0,
            abortController: new AbortController(),
        };
        const upsertByProviderRunId = jest.fn(async () => undefined);

        await expect(executeSegmentTask({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            rootTaskId: 'root-task',
            parentTaskId: 'parent-task',
            agentId: 'agent-1',
            wake: { trigger: 'start', input: {} },
            idempotencyKey: 'task-1:start',
        }, ctx as never, {
            turnExecutor: turnExecutor as never,
            driverRuns: { upsertByProviderRunId } as never,
        }))
            .rejects.toBeInstanceOf(NonRetryableError);
        expect(turnExecutor.runSegment).toHaveBeenCalledTimes(1);
        expect(upsertByProviderRunId).toHaveBeenCalledTimes(2);
        expect(upsertByProviderRunId).toHaveBeenNthCalledWith(1, expect.objectContaining({
            rootTaskId: 'root-task', parentTaskId: 'parent-task', status: 'running',
        }));
        expect(upsertByProviderRunId).toHaveBeenNthCalledWith(2, expect.objectContaining({
            rootTaskId: 'root-task', parentTaskId: 'parent-task', status: 'failed',
        }));
    });

    it('passes Hatchet cancellation to the turn executor', async () => {
        const abortController = new AbortController();
        const runSegment = jest.fn(async (params) => {
            expect(params.abortSignal).toBe(abortController.signal);
            return {
                tenantId: 'tenant-1', taskId: 'task-1',
                boundary: { kind: 'complete' }, taskStatus: { state: 'completed' },
            };
        });
        await executeSegmentTask({
            tenantId: 'tenant-1', taskId: 'task-1',
            wake: { trigger: 'start', input: {} }, idempotencyKey: 'task-1:start',
        }, {
            workflowRunId: () => 'workflow-1',
            taskRunExternalId: () => 'task-run-1',
            abortController,
        } as never, { turnExecutor: { runSegment } as never });
        expect(runSegment).toHaveBeenCalledTimes(1);
    });

    it('closes the provider attempt before optional post-commit work', async () => {
        const order: string[] = [];
        const upsertByProviderRunId = jest.fn(async (record: { status: string }) => {
            order.push(`driver:${record.status}`);
        });
        const postCommitWork = jest.fn(async () => {
            order.push('post-commit');
        });
        const runSegment = jest.fn(async () => ({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            boundary: { kind: 'complete' as const },
            taskStatus: 'completed' as const,
            postCommitWork,
        }));

        await executeSegmentTask({
            tenantId: 'tenant-1', taskId: 'task-1',
            wake: { trigger: 'start', input: {} }, idempotencyKey: 'task-1:start',
        }, {
            workflowRunId: () => 'workflow-1',
            taskRunExternalId: () => 'task-run-1',
            abortController: new AbortController(),
        } as never, {
            turnExecutor: { runSegment } as never,
            driverRuns: { upsertByProviderRunId } as never,
        });

        expect(order).toEqual(['driver:running', 'driver:completed', 'post-commit']);
    });

    it('declares durable parent tasks with an explicit execution timeout', () => {
        const durableTask = jest.fn((options: unknown) => options);

        createTaskTask({ durableTask } as never);

        expect(durableTask).toHaveBeenCalledWith(expect.objectContaining({
            executionTimeout: '30m',
            retries: 0,
        }));
    });

    it('allows durable parent task execution timeout override', () => {
        const durableTask = jest.fn((options: unknown) => options);

        createTaskTask({ durableTask } as never, undefined, 'agent.fetch-browser', {
            executionTimeout: '6m',
        });

        expect(durableTask).toHaveBeenCalledWith(expect.objectContaining({
            executionTimeout: '6m',
            retries: 0,
        }));
    });

    it('creates a coherent namespaced protocol without changing production defaults', () => {
        expect(DEFAULT_TASK_PROTOCOL_NAMES).toEqual({
            task: TASK_TASK_NAME,
            segment: SEGMENT_TASK_NAME,
            taskState: TASK_STATE_TASK_NAME,
        });
        expect(createNamespacedTaskProtocolNames('aplret.test.run-1.')).toEqual({
            task: 'aplret.test.run-1.task',
            segment: 'aplret.test.run-1.segment',
            taskState: 'aplret.test.run-1.task-state',
        });
        expect(() => createNamespacedTaskProtocolNames('  '))
            .toThrow('HATCHET_TASK_PROTOCOL_NAMESPACE_REQUIRED');
    });

    it('routes a custom durable protocol only through its matching child names', async () => {
        const durableTask = jest.fn((options: unknown) => options);
        const stateTask = jest.fn((options: unknown) => options);
        const protocolNames = createNamespacedTaskProtocolNames('aplret.test.isolated');
        createTaskStateTask({ task: stateTask } as never, {}, { name: protocolNames.taskState });
        const definition = createTaskTask(
            { durableTask } as never,
            {},
            protocolNames.task,
            { protocolNames }
        ) as unknown as { fn: (input: unknown, ctx: unknown) => Promise<unknown> };
        const ctx = {
            runChild: jest.fn(async (name: string) => {
                if (name === protocolNames.taskState) return { [protocolNames.taskState]: {} };
                if (name === protocolNames.segment) {
                    const output = {
                        tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                        boundary: { kind: 'complete', result: { ok: true } },
                        taskStatus: { state: 'completed', timestamp: '2026-07-22T00:00:00.000Z' },
                        turnDisposition: 'executed', turnSeq: 1, claimedGeneration: '1',
                    };
                    return { [protocolNames.segment]: output };
                }
                throw new Error(`Unexpected child ${name}`);
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await definition.fn({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1', input: {},
            idempotencyKey: 'task-1:start', tenantTaskKey: 'tenant-1:task-1',
            rootTaskId: 'root-task', parentTaskId: 'parent-task',
            rootRunKey: 'tenant-1:task-1:root:1',
        }, ctx);

        expect(durableTask).toHaveBeenCalledWith(expect.objectContaining({ name: protocolNames.task }));
        expect(stateTask).toHaveBeenCalledWith(expect.objectContaining({ name: protocolNames.taskState }));
        expect(ctx.runChild).toHaveBeenCalledWith(
            protocolNames.segment,
            expect.objectContaining({ rootTaskId: 'root-task', parentTaskId: 'parent-task' }),
            expect.any(Object),
        );
        expect(ctx.runChild).not.toHaveBeenCalledWith(
            SEGMENT_TASK_NAME,
            expect.anything(),
            expect.anything(),
        );
    });

    it('rejects a mismatched custom root protocol before registration', () => {
        const durableTask = jest.fn((options: unknown) => options);
        const protocolNames = createNamespacedTaskProtocolNames('aplret.test.mismatch');

        expect(() => createTaskTask(
            { durableTask } as never,
            {},
            'another-root',
            { protocolNames }
        )).toThrow('HATCHET_TASK_PROTOCOL_ROOT_NAME_MISMATCH');
        expect(durableTask).not.toHaveBeenCalled();
    });

    it('rejects a mismatched task-state registration before publishing it', () => {
        const task = jest.fn((options: unknown) => options);
        const protocolNames = createNamespacedTaskProtocolNames('aplret.test.state-mismatch');

        expect(() => createTaskStateTask(
            { task } as never,
            { protocolNames },
            { name: 'another-state-task' }
        )).toThrow('HATCHET_TASK_PROTOCOL_STATE_NAME_MISMATCH');
        expect(task).not.toHaveBeenCalled();
    });

    it('declares the sole durable root with native per-task concurrency', () => {
        const durableTask = jest.fn((options: unknown) => options);

        createTaskTask({ durableTask } as never);

        expect(durableTask).toHaveBeenCalledWith(expect.objectContaining({
            name: TASK_TASK_NAME,
            retries: 0,
            concurrency: expect.objectContaining({
                expression: 'input.tenantTaskKey',
                maxRuns: 1,
            }),
        }));
    });

    it('keeps the production durable root orchestration-only and routes state through task-state children', async () => {
        const durableTask = jest.fn((options: unknown) => options);
        const findMany = jest.fn(async () => []);
        const findUnique = jest.fn(async () => null);
        const finalizeRootRun = jest.fn(async () => undefined);
        const load = jest.fn(async () => null);
        const schedule = jest.fn(async () => undefined);
        const definition = createTaskTask({ durableTask } as never, {
            prisma: {
                outbox: { findMany },
                wMSession: { findUnique },
                wMEvent: { findMany },
            } as never,
            driverRuns: { finalizeRootRun } as never,
            sessionManager: { load } as never,
            runtimeTimers: { schedule } as never,
        }) as unknown as { fn: (input: unknown, ctx: unknown) => Promise<unknown> };
        const ctx = {
            runChild: jest.fn(async (name: string, childInput: any) => {
                if (name === TASK_STATE_TASK_NAME) return {};
                if (name === SEGMENT_TASK_NAME) {
                    return {
                        tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                        boundary: { kind: 'complete', result: { ok: true } },
                        taskStatus: { state: 'completed', timestamp: '2026-07-19T00:00:00.000Z' },
                        turnDisposition: 'executed', turnSeq: 1, claimedGeneration: '1',
                    };
                }
                throw new Error(`Unexpected child ${name}: ${JSON.stringify(childInput)}`);
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await definition.fn({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1', input: { value: 'hello' },
            idempotencyKey: 'task-1:start', tenantTaskKey: '8:tenant-1:6:task-1',
            rootRunKey: '8:tenant-1:6:task-1:root:1',
        }, ctx);

        expect(ctx.runChild).toHaveBeenCalledWith(
            TASK_STATE_TASK_NAME,
            expect.objectContaining({ operation: 'bootstrap' }),
            expect.any(Object),
        );
        expect(ctx.runChild).toHaveBeenCalledWith(
            TASK_STATE_TASK_NAME,
            expect.objectContaining({ operation: 'list_outbox' }),
            expect.any(Object),
        );
        expect(ctx.runChild).toHaveBeenCalledWith(
            TASK_STATE_TASK_NAME,
            expect.objectContaining({ operation: 'project_terminal' }),
            expect.any(Object),
        );
        expect(findMany).not.toHaveBeenCalled();
        expect(findUnique).not.toHaveBeenCalled();
        expect(finalizeRootRun).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
    });

    it('unwraps task-state child output before reading a recorded boundary timer', async () => {
        const durableTask = jest.fn((options: unknown) => options);
        const definition = createTaskTask({ durableTask } as never, {} as never) as unknown as {
            fn: (input: unknown, ctx: unknown) => Promise<any>;
        };
        const dueAt = new Date(Date.now() + 60_000).toISOString();
        const firedAt = new Date(Date.now() + 60_001).toISOString();
        const segmentOutputs = [
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'await_input', token: 'input-token', expiresAt: dueAt },
                taskStatus: { state: 'working', timestamp: '2026-07-19T00:00:00.000Z' },
                turnDisposition: 'executed', turnSeq: 1, claimedGeneration: '1',
            },
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-07-19T00:00:01.000Z' },
                turnDisposition: 'executed', turnSeq: 2, claimedGeneration: '2',
            },
        ];
        const stateOutput = (output: Record<string, unknown>) => ({
            [TASK_STATE_TASK_NAME]: output,
        });
        const ctx = {
            runChild: jest.fn(async (name: string, childInput: any) => {
                if (name === SEGMENT_TASK_NAME) return segmentOutputs.shift();
                if (name !== TASK_STATE_TASK_NAME) throw new Error(`Unexpected child ${name}`);
                if (childInput.operation === 'schedule_timer') {
                    return stateOutput({
                        timer: {
                            timerId: 'timer-1', dueAt, kind: 'token_expiry',
                            idempotencyKey: 'timer:tenant-1:task-1:input-token:timer-1',
                        },
                    });
                }
                if (childInput.operation === 'mark_timer_fired') {
                    return stateOutput({ firedAt });
                }
                return stateOutput({});
            }),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({ timer: {} })),
        };

        await definition.fn({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1', input: {},
            idempotencyKey: 'task-1:start', tenantTaskKey: '8:tenant-1:6:task-1',
            rootRunKey: '8:tenant-1:6:task-1:root:1',
        }, ctx);

        expect(ctx.runChild).toHaveBeenCalledWith(
            TASK_STATE_TASK_NAME,
            expect.objectContaining({ operation: 'schedule_timer' }),
            expect.any(Object),
        );
        expect(ctx.runChild).toHaveBeenCalledWith(
            SEGMENT_TASK_NAME,
            expect.objectContaining({
                wake: {
                    trigger: 'timer',
                    event: expect.objectContaining({
                        kind: 'timer', token: 'input-token', timerId: 'timer-1', firedAt,
                    }),
                },
            }),
            expect.any(Object),
        );
    });

    it('reloads authoritative state for a replay instead of trusting the segment boundary', async () => {
        const durableTask = jest.fn((options: unknown) => options);
        const definition = createTaskTask({ durableTask } as never, {} as never) as unknown as {
            fn: (input: unknown, ctx: unknown) => Promise<any>;
        };
        const projected: any[] = [];
        const ctx = {
            runChild: jest.fn(async (name: string, childInput: any) => {
                if (name === SEGMENT_TASK_NAME) {
                    return {
                        tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                        boundary: { kind: 'complete', result: { source: 'stale-segment' } },
                        taskStatus: { state: 'completed', timestamp: '2026-07-19T00:00:00.000Z' },
                        turnDisposition: 'terminal_replay',
                    };
                }
                if (childInput.operation === 'reload_authoritative') {
                    return { authoritativeBoundary: { kind: 'complete', result: { source: 'durable-snapshot' } } };
                }
                if (childInput.operation === 'project_terminal') projected.push(childInput.segment);
                return {};
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        const result = await definition.fn({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1', input: {},
            idempotencyKey: 'task-1:start', tenantTaskKey: '8:tenant-1:6:task-1',
            rootRunKey: '8:tenant-1:6:task-1:root:1',
        }, ctx);

        expect(result.boundary).toEqual({ kind: 'complete', result: { source: 'durable-snapshot' } });
        expect(projected).toEqual([expect.objectContaining({
            boundary: { kind: 'complete', result: { source: 'durable-snapshot' } },
        })]);
    });

    it('retries a queued turn with a fresh segment child key', async () => {
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'continue' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
                turnDisposition: 'queued',
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
                turnDisposition: 'executed',
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            sleepFor: jest.fn(async () => undefined),
        };

        await executeTaskTask({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            rootTaskId: 'task-1',
            tenantTaskKey: '8:tenant-1:6:task-1',
            rootRunKey: '8:tenant-1:6:task-1:root:1',
            agentId: 'agent-1',
            input: { value: 'hello' },
            idempotencyKey: 'task-1:turn-request:1',
            recoveryGeneration: '1',
            recoveryDeliveryKey: 'task-1:turn-request:1',
        }, ctx as never);

        expect(ctx.sleepFor).toHaveBeenCalledWith('1s', 'turn-owner:1');
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            1,
            SEGMENT_TASK_NAME,
            expect.objectContaining({ attemptSeq: 1, recoveryGeneration: '1' }),
            expect.objectContaining({ key: '8:tenant-1:6:task-1:root:1:segment:1:task-1:turn-request:1' })
        );
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            SEGMENT_TASK_NAME,
            expect.objectContaining({ attemptSeq: 2, recoveryGeneration: '1' }),
            expect.objectContaining({ key: '8:tenant-1:6:task-1:root:1:segment:2:task-1:turn-request:1' })
        );
    });

    it('consumes scanner-staged recovery from a queued segment without polling churn', async () => {
        const segmentOutputs = [
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'paused', reason: 'authoritative_state_unavailable' },
                taskStatus: { state: 'working', timestamp: '2026-09-05T10:00:00.000Z' },
                turnDisposition: 'queued',
                recoveryHint: {
                    reason: 'lease_expired', generation: '1',
                    deliveryKey: 'task-1:turn-request:1', turnSeq: 1,
                },
            },
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'complete', result: { recovered: true } },
                taskStatus: { state: 'completed', timestamp: '2026-09-05T10:00:01.000Z' },
                turnDisposition: 'executed', claimedGeneration: '1', turnSeq: 1,
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            sleepFor: jest.fn(async () => undefined),
        };

        const result = await executeTaskTask({
            tenantId: 'tenant-1', taskId: 'task-1', rootTaskId: 'task-1',
            tenantTaskKey: '8:tenant-1:6:task-1', rootRunKey: '8:tenant-1:6:task-1:root:1',
            agentId: 'agent-1', input: {}, idempotencyKey: 'task-1:start',
        }, ctx as never);

        expect(result.boundary).toEqual({ kind: 'complete', result: { recovered: true } });
        expect(ctx.runChild).toHaveBeenCalledTimes(2);
        expect(ctx.sleepFor).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            SEGMENT_TASK_NAME,
            expect.objectContaining({
                attemptSeq: 2,
                recoveryGeneration: '1',
                idempotencyKey: 'task-1:turn-request:1',
            }),
            expect.objectContaining({
                key: '8:tenant-1:6:task-1:root:1:segment:2:task-1:turn-request:1',
            })
        );
    });

    it('uses a recovery event hint to claim the staged generation on the next attempt', async () => {
        const segmentOutputs = [
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'paused', reason: 'authoritative_state_unavailable' },
                taskStatus: { state: 'working', timestamp: '2026-09-05T10:00:00.000Z' },
                turnDisposition: 'queued',
            },
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'complete', result: { recovered: true } },
                taskStatus: { state: 'completed', timestamp: '2026-09-05T10:00:01.000Z' },
                turnDisposition: 'executed', claimedGeneration: '1', turnSeq: 1,
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            now: jest.fn(async () => new Date('2026-09-05T10:00:00.000Z')),
            waitFor: jest.fn(async () => ({
                CREATE: {
                    available: [{
                        id: 'event-1',
                        data: {
                            recoveryHint: {
                                reason: 'lease_expired', generation: '1',
                                deliveryKey: 'task-1:turn-request:1', turnSeq: 1,
                            },
                        },
                    }],
                },
            })),
        };

        await executeTaskTask({
            tenantId: 'tenant-1', taskId: 'task-1', rootTaskId: 'task-1',
            tenantTaskKey: '8:tenant-1:6:task-1', rootRunKey: '8:tenant-1:6:task-1:root:1',
            agentId: 'agent-1', input: {}, idempotencyKey: 'task-1:start',
        }, ctx as never);

        expect(ctx.waitFor).toHaveBeenCalledTimes(1);
        expect(ctx.runChild).toHaveBeenCalledTimes(2);
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            SEGMENT_TASK_NAME,
            expect.objectContaining({ recoveryGeneration: '1', idempotencyKey: 'task-1:turn-request:1' }),
            expect.any(Object)
        );
    });

    it('waits for same-generation redelivery after an expired-lease recovery handoff', async () => {
        const segmentOutputs = [
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'paused', reason: 'authoritative_state_unavailable' },
                taskStatus: { state: 'working', timestamp: '2026-09-04T10:00:00.000Z' },
                turnDisposition: 'lease_expired_recovery_staged',
                claimedGeneration: '1', turnSeq: 1,
            },
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'complete', result: { recovered: true } },
                taskStatus: { state: 'completed', timestamp: '2026-09-04T10:00:01.000Z' },
                turnDisposition: 'executed', claimedGeneration: '1', turnSeq: 1,
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            sleepFor: jest.fn(async () => undefined),
        };

        const result = await executeTaskTask({
            tenantId: 'tenant-1', taskId: 'task-1', rootTaskId: 'task-1',
            tenantTaskKey: '8:tenant-1:6:task-1', rootRunKey: '8:tenant-1:6:task-1:root:1',
            agentId: 'agent-1', input: {}, idempotencyKey: 'task-1:start',
        }, ctx as never);

        expect(result.boundary).toEqual({ kind: 'complete', result: { recovered: true } });
        expect(ctx.sleepFor).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            SEGMENT_TASK_NAME,
            expect.objectContaining({
                recoveryGeneration: '1',
                idempotencyKey: 'task-1:turn-request:1',
            }),
            expect.objectContaining({
                key: '8:tenant-1:6:task-1:root:1:segment:2:task-1:turn-request:1',
            })
        );
    });

    it('finalizes the root driver run when the durable parent reaches a complete boundary', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:00.000Z' },
                traceId: 'trace-1',
                turnTraceId: 'turn-trace-1',
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        );

        expect(finalizeRootRun).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
            agentId: 'agent-1',
            traceId: 'trace-1',
            boundaryKind: 'complete',
            turnTraceId: 'turn-trace-1',
        });
    });

    it('writes successful durable task results to the previous-run result cache when enabled', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const setCachedResult = jest.fn(async () => undefined);
        const getCachedResult = jest.fn(async () => null);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'fetch-html',
                boundary: { kind: 'complete', result: { ok: true, data: { html: '<html>ok</html>' } } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:00.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'fetch-html',
                input: { url: 'https://example.test/listing.html' },
                cache: { enabled: true, ttlSeconds: 900, excludePaths: ['traceparent'] },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                agentResultCache: { getCachedResult, setCachedResult } as never,
            }
        );

        expect(getCachedResult).toHaveBeenCalledWith(
            'fetch-html',
            { url: 'https://example.test/listing.html' },
            ['traceparent'],
            'tenant-1'
        );
        expect(setCachedResult).toHaveBeenCalledWith(
            'fetch-html',
            { url: 'https://example.test/listing.html' },
            { ok: true, data: { html: '<html>ok</html>' } },
            900,
            ['traceparent'],
            'tenant-1'
        );
    });

    it('does not cache durable semantic failures', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const setCachedResult = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'fetch-html',
                boundary: {
                    kind: 'complete',
                    result: {
                        ok: false,
                        error: { code: 'NO_HTML', message: 'No HTML available' },
                    },
                },
                taskStatus: { state: 'failed', timestamp: '2026-06-19T00:00:00.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'fetch-html',
                input: { url: 'https://example.test/listing.html' },
                cache: { enabled: true },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                agentResultCache: {
                    getCachedResult: jest.fn(async () => null),
                    setCachedResult,
                } as never,
            }
        );

        expect(setCachedResult).not.toHaveBeenCalled();
    });

    it('returns cached durable task results without running a segment', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => {
                throw new Error('segment should not run on cache hit');
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        const result = await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'fetch-html',
                input: { url: 'https://example.test/listing.html' },
                cache: { enabled: true },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                agentResultCache: {
                    getCachedResult: jest.fn(async () => ({ ok: true, data: { html: '<html>cached</html>' } })),
                    setCachedResult: jest.fn(async () => undefined),
                } as never,
            }
        );

        expect(ctx.runChild).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'fetch-html',
            boundary: { kind: 'complete', result: { ok: true, data: { html: '<html>cached</html>' } } },
            executionMetadata: { origin: 'cache' },
        }));
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
            boundaryKind: 'complete',
        }));
    });

    it('persists a durable terminal when task-state projects a cached root result', async () => {
        const memory = createMemorySessions({
            'task-1': { meta: {
                agentId: 'fetch-html',
                turnCoordinator: {
                    schemaVersion: 1,
                    runtimeSurface: 'hatchet',
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '1',
                    completedGeneration: '0',
                    dispatchIntent: {
                        generation: '1',
                        deliveryKey: 'task-1:turn-request:1',
                        runtimeSurface: 'hatchet',
                        createdAt: '2026-07-31T00:00:00.000Z',
                    },
                },
            } },
        });
        const setCachedResult = jest.fn(async () => undefined);

        const output = await executeTaskStateTask({
            operation: 'project_terminal',
            task: {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html', input: { url: 'x' },
                cache: { enabled: true }, idempotencyKey: 'task-1:turn-request:1',
                recoveryGeneration: '1', recoveryDeliveryKey: 'task-1:turn-request:1',
            },
            segment: {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html',
                boundary: { kind: 'complete', result: { ok: true, data: 'cached' } },
                taskStatus: {
                    state: 'completed', timestamp: '2000-01-01T00:00:00.000Z',
                    metadata: { source: 'cache', origin: 'cache' },
                } as never,
                executionMetadata: { origin: 'cache' },
            },
        }, {
            sessionManager: memory.sessionManager,
            agentResultCache: {
                getCachedResult: jest.fn(async () => null), setCachedResult,
            } as never,
        });

        expect(output.terminalSegment?.boundary).toEqual({
            kind: 'complete', result: { ok: true, data: 'cached' },
        });
        expect(memory.snapshots.get('task-1')).toEqual(expect.objectContaining({
            meta: expect.objectContaining({
                taskLifecycle: expect.objectContaining({ state: 'completed' }),
                taskTerminal: expect.objectContaining({
                    state: 'completed',
                    status: expect.objectContaining({
                        state: 'completed',
                        metadata: expect.objectContaining({
                            result: { ok: true, data: 'cached' },
                            source: 'cache',
                            origin: 'cache',
                        }),
                    }),
                }),
                turnCoordinator: expect.objectContaining({
                    requestedGeneration: '1',
                    completedGeneration: '1',
                }),
            }),
        }));
        expect((memory.snapshots.get('task-1')?.meta as any)?.turnCoordinator?.dispatchIntent)
            .toBeUndefined();
        expect(setCachedResult).toHaveBeenCalledTimes(1);
    });

    it('completes and wakes an async cached child, with replay-safe diagnostics and cache provenance', async () => {
        const memory = createMemorySessions({
            'child-task-1': {
                meta: {
                    agentId: 'fetch-html',
                    taskLifecycle: {
                        taskId: 'child-task-1', rootTaskId: 'parent-task-1',
                        parentTaskId: 'parent-task-1', ancestorTaskIds: ['parent-task-1'], state: 'active',
                    },
                    a2aParent: {
                        parentTenantId: 'tenant-1', parentTaskId: 'parent-task-1',
                        parentChildToken: 'child-token',
                    },
                },
            },
            'parent-task-1': {
                meta: {
                    agentId: 'parent-agent', turn: 1,
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '1', completedGeneration: '1',
                    },
                },
                pending: {
                    tasks: {
                        'child-token': {
                            target: 'fetch-html', agentId: 'fetch-html',
                            childTaskId: 'child-task-1', handlers: {},
                        },
                    },
                    children: { 'child-token': { agent: 'fetch-html' } },
                },
            },
        });
        const events = { push: jest.fn(async () => undefined) };
        const finalizeRootRun = jest.fn(async () => undefined);
        const getCachedResult = jest.fn(async () => ({ ok: true, data: { html: '<html>cached</html>' } }));
        const setCachedResult = jest.fn(async () => undefined);
        const prisma = {
            outbox: { findMany: jest.fn(async () => []) },
            wMSession: {
                findUnique: jest.fn(async (args: any) => {
                    const snapshot = memory.snapshots.get(args.where.tenantId_sessionId.sessionId);
                    return snapshot === undefined ? null : { snapshot };
                }),
            },
        };
        const ctx = {
            runChild: jest.fn(async () => { throw new Error('segment should not run on cache hit'); }),
            runNoWaitChild: jest.fn(async () => undefined),
        };
        const input = {
            tenantId: 'tenant-1', taskId: 'child-task-1', agentId: 'fetch-html',
            input: { url: 'https://example.test/listing.html' }, cache: { enabled: true },
            idempotencyKey: 'child-task-1:start',
        } as const;
        const deps = {
            driverRuns: { finalizeRootRun } as never,
            sessionManager: memory.sessionManager,
            events,
            prisma: prisma as never,
            agentResultCache: { getCachedResult, setCachedResult } as never,
        };

        await executeTaskTask(input as never, ctx as never, deps);
        await executeTaskTask(input as never, ctx as never, deps);

        expect(ctx.runChild).not.toHaveBeenCalled();
        expect(memory.appendEvent).toHaveBeenCalledTimes(1);
        expect(memory.appendEvent).toHaveBeenCalledWith(
            'tenant-1',
            'parent-task-1',
            'task.child_completed',
            expect.objectContaining({
                token: 'child-token',
                childTaskId: 'child-task-1',
                executionMetadata: { origin: 'cache' },
            })
        );
        expect(events.push).toHaveBeenCalledTimes(2);
        expect(events.push).toHaveBeenLastCalledWith(
            'aplret.child.child-token',
            expect.objectContaining({ outcome: 'completed', terminalClaimed: true }),
            { key: 'tenant-1:parent-task-1:child-token' }
        );
        expect((memory.snapshots.get('child-task-1') as any).meta.taskTerminal.status.metadata)
            .toEqual(expect.objectContaining({ origin: 'cache', source: 'cache' }));
    });

    it('does not overwrite a cancellation that wins before cached terminal projection', async () => {
        const memory = createMemorySessions({
            'task-1': {
                meta: {
                    agentId: 'fetch-html',
                    taskLifecycle: {
                        taskId: 'task-1', rootTaskId: 'task-1', ancestorTaskIds: [],
                        state: 'canceled', changedAt: '2026-07-22T00:00:00.000Z', reason: 'operator_cancel',
                    },
                },
            },
        });
        const setCachedResult = jest.fn(async () => undefined);
        const finalizeRootRun = jest.fn(async () => undefined);
        const result = await executeTaskTask({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html', input: {},
            cache: { enabled: true }, idempotencyKey: 'task-1:start',
        }, {
            runChild: jest.fn(async () => { throw new Error('segment should not run'); }),
            runNoWaitChild: jest.fn(async () => undefined),
        } as never, {
            sessionManager: memory.sessionManager,
            driverRuns: { finalizeRootRun } as never,
            agentResultCache: {
                getCachedResult: jest.fn(async () => ({ ok: true })), setCachedResult,
            } as never,
        });

        expect(result.boundary).toEqual({ kind: 'canceled', reason: 'operator_cancel' });
        expect((memory.snapshots.get('task-1') as any).meta.taskLifecycle.state).toBe('canceled');
        expect((memory.snapshots.get('task-1') as any).meta.taskTerminal.state).toBe('canceled');
        expect(setCachedResult).not.toHaveBeenCalled();
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'canceled' }));
    });

    it('offloads oversized cached HTML before committing it and does not nest artifact markers', async () => {
        const memory = createMemorySessions({ 'task-1': { meta: { agentId: 'fetch-html' } } });
        const html = `<html>${'x'.repeat(70_000)}</html>`;
        const storeArtifact = jest.fn(async () => ({ size: html.length, artifactId: 'artifact-html' }));
        const cachedResult: unknown = { ok: true, data: { html } };
        const setCachedResult = jest.fn(async () => undefined);
        const input = {
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html', input: {},
            cache: { enabled: true }, idempotencyKey: 'task-1:start',
        } as const;
        const ctx = {
            runChild: jest.fn(async () => { throw new Error('segment should not run'); }),
            runNoWaitChild: jest.fn(async () => undefined),
        };
        const deps = {
            sessionManager: memory.sessionManager,
            agentResultCache: {
                getCachedResult: jest.fn(async () => cachedResult),
                setCachedResult,
                storeArtifact,
            } as never,
        };
        const result = await executeTaskTask(input as never, ctx as never, deps);
        const replay = await executeTaskTask(input as never, ctx as never, deps);
        const marker = {
            kind: 'artifact', id: 'artifact-html', mimeType: 'text/html', estimatedSize: html.length,
        };

        expect(result.boundary).toEqual({ kind: 'complete', result: { ok: true, data: { html: marker } } });
        expect(replay.boundary).toEqual(result.boundary);
        expect((memory.snapshots.get('task-1') as any).meta.taskTerminal.status.metadata.result)
            .toEqual({ ok: true, data: { html: marker } });
        expect(setCachedResult).toHaveBeenCalledWith(
            'fetch-html', {}, { ok: true, data: { html: marker } }, 300, [], 'tenant-1'
        );
        expect(storeArtifact).toHaveBeenCalledTimes(1);
    });

    it('does not claim a cached terminal when required artifact persistence fails', async () => {
        const memory = createMemorySessions({ 'task-1': { meta: { agentId: 'fetch-html' } } });
        const finalizeRootRun = jest.fn(async () => undefined);
        const html = `<html>${'x'.repeat(70_000)}</html>`;
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await expect(executeTaskTask({
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html', input: {},
                cache: { enabled: true }, idempotencyKey: 'task-1:start',
            }, {
                runChild: jest.fn(async () => { throw new Error('segment should not run'); }),
                runNoWaitChild: jest.fn(async () => undefined),
            } as never, {
                sessionManager: memory.sessionManager,
                driverRuns: { finalizeRootRun } as never,
                agentResultCache: {
                    getCachedResult: jest.fn(async () => ({ ok: true, data: { html } })),
                    setCachedResult: jest.fn(async () => undefined),
                    storeArtifact: jest.fn(async () => { throw new Error('artifact store unavailable'); }),
                } as never,
            })).rejects.toMatchObject({ code: 'ARTIFACT_PERSISTENCE_FAILED' });
        } finally {
            consoleError.mockRestore();
        }

        expect((memory.snapshots.get('task-1') as any).meta.taskTerminal).toBeUndefined();
        expect(memory.sessionManager.saveSnapshot).not.toHaveBeenCalled();
        expect(finalizeRootRun).not.toHaveBeenCalled();
    });

    it('retains completed durable semantics for a cached ok:false result', async () => {
        const memory = createMemorySessions({ 'task-1': { meta: { agentId: 'fetch-html' } } });
        const finalizeRootRun = jest.fn(async () => undefined);
        await executeTaskTask({
            tenantId: 'tenant-1', taskId: 'task-1', agentId: 'fetch-html', input: {},
            cache: { enabled: true }, idempotencyKey: 'task-1:start',
        }, {
            runChild: jest.fn(async () => { throw new Error('segment should not run'); }),
            runNoWaitChild: jest.fn(async () => undefined),
        } as never, {
            sessionManager: memory.sessionManager,
            driverRuns: { finalizeRootRun } as never,
            agentResultCache: {
                getCachedResult: jest.fn(async () => ({
                    ok: false, error: { code: 'NO_HTML', message: 'No HTML' },
                })),
                setCachedResult: jest.fn(async () => undefined),
            } as never,
        });

        expect((memory.snapshots.get('task-1') as any).meta.taskTerminal.state).toBe('completed');
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });

    it('finalizes complete ok:false outcomes as failed semantic runs', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: {
                    kind: 'complete',
                    result: {
                        ok: false,
                        error: { code: 'NO_URL', message: 'No URL provided' },
                    },
                },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:00.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        );

        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'failed',
            boundaryKind: 'complete',
        }));
    });

    it('finalizes canceled segment boundaries as canceled root runs', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'canceled', reason: 'operator stop' },
                taskStatus: 'canceled',
                traceId: 'trace-1',
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        );

        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'canceled',
            boundaryKind: 'canceled',
            traceId: 'trace-1',
        }));
        expect(ctx.runChild).toHaveBeenCalledTimes(1);
    });

    it('pushes a parent child wake event when an async durable child reaches a terminal boundary', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const events = { push: jest.fn(async () => undefined) };
        const appendEvent = jest.fn(async () => ({ eventId: 'event-1', seq: 1 }));
        let parentSnapshot: Record<string, unknown> = {
            meta: {
                agentId: 'parent-agent',
                turn: 1,
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '1',
                    completedGeneration: '1',
                },
            },
            pending: {
                tasks: {
                    'parent-token': {
                        target: 'agent-1', agentId: 'agent-1', childTaskId: 'child-task-1', handlers: {},
                    },
                },
                children: { 'parent-token': { agent: 'agent-1' } },
            },
        };
        let parentVersion = BigInt(1);
        const sessionManager = {
            load: jest.fn(async () => ({ snapshot: parentSnapshot, wmVersion: parentVersion, agentId: 'parent-agent' })),
            saveSnapshot: jest.fn(async (params: { snapshot: Record<string, unknown> }) => {
                parentSnapshot = params.snapshot;
                parentVersion += BigInt(1);
                return { snapshot: parentSnapshot, wmVersion: parentVersion };
            }),
            appendEvent,
        };
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'child-task-1',
                agentId: 'agent-1',
                boundary: {
                    kind: 'complete',
                    result: {
                        ok: false,
                        error: { code: 'ALL_MODES_FAILED', message: 'No content' },
                    },
                },
                taskStatus: { state: 'failed', timestamp: '2026-06-19T00:00:00.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'child-task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'child-task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                sessionManager,
                events,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMSession: {
                        findUnique: jest.fn(async () => ({
                            snapshot: {
                                meta: {
                                    a2aParent: {
                                        parentTenantId: 'tenant-1',
                                        parentTaskId: 'parent-task-1',
                                        parentChildToken: 'parent-token',
                                    },
                                    taskTerminal: {
                                        taskId: 'child-task-1',
                                        state: 'completed',
                                        claimedAt: '2026-06-19T00:00:00.000Z',
                                        deliveryKey: 'child-task-1:terminal',
                                        status: {
                                            state: 'completed',
                                            timestamp: '2026-06-19T00:00:00.000Z',
                                            metadata: {
                                                result: {
                                                    ok: false,
                                                    error: { code: 'ALL_MODES_FAILED', message: 'No content' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        })),
                    },
                } as never,
            }
        );

        expect(appendEvent).toHaveBeenCalledWith(
            'tenant-1',
            'parent-task-1',
            'task.child_completed',
            expect.objectContaining({
                token: 'parent-token', childTaskId: 'child-task-1', agentId: 'agent-1',
            })
        );
        expect(events.push).toHaveBeenCalledWith(
            'aplret.child.parent-token',
            {
                tenantId: 'tenant-1',
                taskId: 'parent-task-1',
                agentId: 'agent-1',
                idempotencyKey: 'parent-task-1:child:parent-token',
                kind: 'child',
                token: 'parent-token',
                childTaskId: 'child-task-1',
                outcome: 'completed',
                output: {
                    ok: false,
                    error: { code: 'ALL_MODES_FAILED', message: 'No content' },
                },
                completedAt: expect.any(String),
                terminalClaimed: true,
            },
            { key: 'tenant-1:parent-task-1:parent-token' }
        );
    });

    it('waits for await_child and resumes the durable parent from the child completion event', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-token' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({
                child: {
                    event1: {
                        tenantId: 'tenant-1',
                        taskId: 'task-1',
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
            })),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        );

        expect(ctx.waitFor).toHaveBeenCalledWith(expect.any(Object), 'wait:child-or-watchdog:child-token:0');
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'child',
                    event: {
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                attemptSeq: 2,
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
            boundaryKind: 'complete',
        }));
    });

    it('waits for await_event and resumes the durable parent from the external event', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_event', token: 'event-token' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitForEvent: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'external',
                token: 'event-token',
                type: 'webhook.received',
                data: { ok: true },
                idempotencyKey: 'task-1:external:event-token',
            })),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        );

        expect(ctx.waitForEvent).toHaveBeenCalledWith(
            'aplret.external.event-token',
            'input.tenantId == "tenant-1" && input.taskId == "task-1"',
            undefined,
            undefined,
            '5m',
            'wait:external:event-token'
        );
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'event',
                    event: {
                        kind: 'external',
                        token: 'event-token',
                        type: 'webhook.received',
                        data: { ok: true },
                        idempotencyKey: 'task-1:external:event-token',
                    },
                },
                idempotencyKey: 'task-1:external:event-token',
                attemptSeq: 2,
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
            boundaryKind: 'complete',
        }));
    });

    it('expires await_input with a runtime timer when the sleep branch wins', async () => {
        const dueAt = new Date(Date.now() + 60_000).toISOString();
        const timer = {
            id: 'timer-row-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            rootTaskId: 'task-1',
            token: 'input-token',
            timerId: 'timer-1',
            dueAt: new Date(dueAt),
            kind: 'token_expiry',
            status: 'scheduled',
            idempotencyKey: 'timer:tenant-1:task-1:input-token:timer-1',
            fireLeaseId: null,
            fireLeaseUntil: null,
            payload: null,
            providerRunId: null,
            providerTaskRunId: null,
            error: null,
            firedAt: null,
            canceledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_input', token: 'input-token', expiresAt: dueAt },
                taskStatus: { state: 'input-required', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({ timer: {} })),
        };
        const runtimeTimers = {
            schedule: jest.fn(async () => timer),
            markFiredByTimerId: jest.fn(async () => true),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { runtimeTimers: runtimeTimers as never }
        );

        expect(runtimeTimers.schedule).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'input-token',
            fireAt: dueAt,
            kind: 'token_expiry',
        }));
        expect(ctx.waitFor).toHaveBeenCalledTimes(1);
        expect(runtimeTimers.markFiredByTimerId).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'input-token',
            timerId: 'timer-1',
        }));
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'timer',
                    event: expect.objectContaining({
                        kind: 'timer',
                        token: 'input-token',
                        timerId: 'timer-1',
                        reason: 'input_timeout',
                    }),
                },
                idempotencyKey: 'timer:tenant-1:task-1:input-token:timer-1',
                attemptSeq: 2,
            }),
            expect.any(Object)
        );
    });

    it('expires await_child with its durable per-call timer before the watchdog', async () => {
        const dueAt = new Date(Date.now() + 60_000).toISOString();
        const timer = {
            id: 'timer-row-child', tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
            rootTaskId: 'task-1', token: 'child-token', timerId: 'timer-child', dueAt: new Date(dueAt),
            kind: 'child_timeout', status: 'scheduled',
            idempotencyKey: 'timer:tenant-1:task-1:child-token:timer-child',
            fireLeaseId: null, fireLeaseUntil: null,
            payload: { timeoutMs: 60_000, childTaskId: 'child-task-1', agentId: 'child-agent' },
            providerRunId: null, providerTaskRunId: null, error: null, firedAt: null, canceledAt: null,
            createdAt: new Date(), updatedAt: new Date(),
        };
        const segmentOutputs = [
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: {
                    kind: 'await_child', token: 'child-token', expiresAt: dueAt, timeoutMs: 60_000,
                    childTaskId: 'child-task-1', agentId: 'child-agent',
                },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                boundary: { kind: 'complete', result: { timedOut: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({ timer: {} })),
        };
        const runtimeTimers = {
            schedule: jest.fn(async () => timer),
            markFiredByTimerId: jest.fn(async () => true),
            cancelTaskTimers: jest.fn(async () => 0),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                input: { value: 'hello' }, idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { runtimeTimers: runtimeTimers as never }
        );

        expect(runtimeTimers.schedule).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', taskId: 'task-1', token: 'child-token',
            fireAt: dueAt, kind: 'child_timeout',
            payload: {
                token: 'child-token', timeoutMs: 60_000,
                childTaskId: 'child-task-1', agentId: 'child-agent',
            },
        }));
        expect(ctx.waitFor).toHaveBeenCalledWith(expect.any(Object), 'wait:child-or-timer:child-token');
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                idempotencyKey: timer.idempotencyKey,
                wake: {
                    trigger: 'timer',
                    event: expect.objectContaining({
                        kind: 'timer', token: 'child-token', timerId: 'timer-child', reason: 'child_timeout',
                    }),
                },
            }),
            expect.any(Object)
        );
    });

    it('resumes await_child from an already persisted child completion before waiting for Hatchet events', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-token' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitForEvent: jest.fn(async () => {
                throw new Error('should not wait');
            }),
        };
        const wMEvent = {
            findMany: jest.fn(async () => [{
                eventId: 'event-1',
                tenantId: 'tenant-1',
                sessionId: 'task-1',
                seq: 2,
                type: 'task.child_completed',
                payload: {
                    token: 'child-token',
                    childTaskId: 'child-task-1',
                    result: {
                        ok: true,
                        data: {
                            html: {
                                kind: 'artifact',
                                id: 'artifact-full',
                                mimeType: 'text/html',
                                estimatedSize: 524_192,
                            },
                        },
                    },
                    resultPreview: {
                        ok: true,
                        data: { html: '<html>... [truncated 1028 chars]' },
                    },
                },
                createdAt: new Date('2026-06-19T00:00:00.500Z'),
            }]),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                } as never,
            }
        );

        expect(wMEvent.findMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                sessionId: 'task-1',
                type: { in: ['task.child_completed', 'task.child_failed'] },
            },
            orderBy: { seq: 'desc' },
            take: 100,
        });
        expect(ctx.waitForEvent).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'child',
                    event: {
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: {
                            ok: true,
                            data: {
                                html: {
                                    kind: 'artifact',
                                    id: 'artifact-full',
                                    mimeType: 'text/html',
                                    estimatedSize: 524_192,
                                },
                            },
                        },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
        }));
    });

    it('recovers await_child from the parent terminal snapshot when event publication was interrupted', async () => {
        const segmentOutputs = [{
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            boundary: { kind: 'complete', result: { ok: true } },
            taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
        }];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => { throw new Error('should not wait'); }),
        };
        const wMEvent = {
            findMany: jest.fn(async (args: { where: { type: { in: string[] } } }) =>
                args.where.type.in.includes('turn.completed')
                    ? [{
                          eventId: 'turn-1', tenantId: 'tenant-1', sessionId: 'task-1', seq: 1,
                          type: 'turn.completed',
                          payload: { turnSeq: 1, transition: { kind: 'await_child', token: 'child-token' } },
                          createdAt: new Date('2026-06-19T00:00:00.000Z'),
                      }]
                    : []),
        };
        const wMSession = {
            findUnique: jest.fn(async () => ({
                snapshot: {
                    meta: { turn: 1, awaiting: { kind: 'await_child', token: 'child-token' } },
                    pending: {
                        children: {},
                        tasks: {},
                        childTerminals: {
                            'child-token': {
                                kind: 'completed',
                                claimedAt: '2026-06-19T00:00:00.500Z',
                                childTaskId: 'child-task-1',
                            },
                        },
                    },
                    inbox: {
                        current: [{
                            source: 'child', kind: 'child.completed',
                            payload: { token: 'child-token', childTaskId: 'child-task-1', result: { durable: true } },
                        }],
                        all: [{
                            source: 'child', kind: 'child.completed',
                            payload: { token: 'child-token', childTaskId: 'child-task-1', result: { durable: true } },
                        }],
                    },
                },
            })),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
                input: {}, idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                    wMSession,
                } as never,
            }
        );

        expect(ctx.waitFor).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                idempotencyKey: 'task-1:child:child-token',
                wake: {
                    trigger: 'child',
                    event: expect.objectContaining({
                        token: 'child-token',
                        outcome: 'completed',
                        output: { durable: true },
                        terminalClaimed: true,
                    }),
                },
            }),
            expect.any(Object)
        );
    });

    it('continues waiting from a persisted await_child when a durable parent re-enters after interruption', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({
                child: {
                    event1: {
                        tenantId: 'tenant-1',
                        taskId: 'task-1',
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
            })),
        };
        const wMEvent = {
            findMany: jest.fn(async (args: { where: { type: { in: string[] } } }) => {
                if (args.where.type.in.includes('turn.completed')) {
                    return [{
                        eventId: 'turn-1',
                        tenantId: 'tenant-1',
                        sessionId: 'task-1',
                        seq: 4,
                        type: 'turn.completed',
                        payload: {
                            turnSeq: 1,
                            transition: { kind: 'await_child', token: 'child-token' },
                        },
                        createdAt: new Date('2026-06-19T00:00:00.000Z'),
                    }];
                }
                return [];
            }),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                } as never,
            }
        );

        expect(ctx.waitFor).toHaveBeenCalledWith(expect.any(Object), 'wait:child-or-watchdog:child-token:0');
        expect(ctx.runChild).toHaveBeenCalledTimes(1);
        expect(ctx.runChild).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'child',
                    event: {
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                attemptSeq: 2,
            }),
            expect.any(Object)
        );
        expect(ctx.runChild).not.toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                wake: { trigger: 'start', input: { value: 'hello' } },
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
        }));
    });

    it('recovers persisted child terminal output from an authoritative task.completed event when Hatchet child wake replay is empty', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
            waitForEvent: jest.fn(async () => ({})),
        };
        const wMEvent = {
            findMany: jest.fn(async (args: { where: { sessionId: string; type: { in: string[] } } }) => {
                const types = args.where.type.in;
                if (args.where.sessionId === 'task-1' && types.includes('turn.completed')) {
                    return [{
                        eventId: 'turn-1',
                        tenantId: 'tenant-1',
                        sessionId: 'task-1',
                        seq: 4,
                        type: 'turn.completed',
                        payload: {
                            turnSeq: 1,
                            transition: { kind: 'await_child', token: 'child-token' },
                        },
                        createdAt: new Date('2026-06-19T00:00:00.000Z'),
                    }];
                }
                if (args.where.sessionId === 'task-1' && types.includes('task.child_started')) {
                    return [{
                        eventId: 'child-started-1',
                        tenantId: 'tenant-1',
                        sessionId: 'task-1',
                        seq: 3,
                        type: 'task.child_started',
                        payload: {
                            token: 'child-token',
                            childTaskId: 'child-task-1',
                            agentId: 'fetch-html',
                        },
                        createdAt: new Date('2026-06-19T00:00:00.000Z'),
                    }];
                }
                if (args.where.sessionId === 'child-task-1' && types.includes('task.completed')) {
                    return [{
                        eventId: 'child-completed-1',
                        tenantId: 'tenant-1',
                        sessionId: 'child-task-1',
                        seq: 3,
                        type: 'task.completed',
                        payload: {
                            taskId: 'child-task-1',
                            result: {
                                ok: true,
                                data: {
                                    html: {
                                        kind: 'artifact',
                                        id: 'artifact-full',
                                        mimeType: 'text/html',
                                        estimatedSize: 524_192,
                                    },
                                    statusCode: 200,
                                },
                            },
                        },
                        createdAt: new Date('2026-06-19T00:00:00.500Z'),
                    }];
                }
                return [];
            }),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                } as never,
            }
        );

        expect(ctx.waitForEvent).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'child',
                    event: {
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'completed',
                        output: {
                            ok: true,
                            data: {
                                html: {
                                    kind: 'artifact',
                                    id: 'artifact-full',
                                    mimeType: 'text/html',
                                    estimatedSize: 524_192,
                                },
                                statusCode: 200,
                            },
                        },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                attemptSeq: 2,
            }),
            expect.any(Object)
        );
    });

    it('does not recover successful await_child output from compact child turn.completed summaries', async () => {
        const previousInterval = process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS;
        const previousMaxWait = process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS;
        const dateNow = jest.spyOn(Date, 'now');
        let now = 1_000;
        dateNow.mockImplementation(() => {
            now += 2_000;
            return now;
        });
        process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS = '1000';
        process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS = '1000';
        try {
            const finalizeRootRun = jest.fn(async () => undefined);
            let watchdogFired = false;
            const segmentOutputs = [
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    boundary: { kind: 'await_child', token: 'child-token' },
                    taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
                },
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    boundary: { kind: 'complete', result: { ok: true } },
                    taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
                },
            ];
            const ctx = {
                runChild: jest.fn(async () => segmentOutputs.shift()),
                runNoWaitChild: jest.fn(async () => undefined),
                waitFor: jest.fn(async () => {
                    watchdogFired = true;
                    return { watchdog: {} };
                }),
                waitForEvent: jest.fn(async () => {
                    throw new Error('should not wait directly for child event');
                }),
            };
            const wMEvent = {
                findMany: jest.fn(async (args: { where: { sessionId: string; type: { in: string[] } } }) => {
                    const types = args.where.type.in;
                    if (args.where.sessionId === 'task-1' && types.includes('task.child_started')) {
                        return [{
                            eventId: 'child-started-1',
                            tenantId: 'tenant-1',
                            sessionId: 'task-1',
                            seq: 2,
                            type: 'task.child_started',
                            payload: {
                                token: 'child-token',
                                childTaskId: 'child-task-1',
                                agentId: 'fetch-html',
                            },
                            createdAt: new Date('2026-06-19T00:00:00.000Z'),
                        }];
                    }
                    if (args.where.sessionId === 'child-task-1' && types.includes('turn.completed') && watchdogFired) {
                        return [{
                            eventId: 'child-turn-1',
                            tenantId: 'tenant-1',
                            sessionId: 'child-task-1',
                            seq: 3,
                            type: 'turn.completed',
                            payload: {
                                turnSeq: 1,
                                transition: {
                                    kind: 'complete',
                                    result: {
                                        ok: true,
                                        data: { html: '<html>... [truncated 1028 chars]', statusCode: 200 },
                                    },
                                },
                            },
                            createdAt: new Date('2026-06-19T00:00:00.500Z'),
                        }];
                    }
                    return [];
                }),
            };

            await executeTaskTask(
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    input: { value: 'hello' },
                    idempotencyKey: 'task-1:start',
                },
                ctx as never,
                {
                    driverRuns: { finalizeRootRun } as never,
                    prisma: {
                        outbox: { findMany: jest.fn(async () => []) },
                        wMEvent,
                    } as never,
                }
            );

            expect(ctx.waitFor).toHaveBeenCalledWith(expect.any(Object), 'wait:child-or-watchdog:child-token:0');
            expect(ctx.waitForEvent).not.toHaveBeenCalled();
            expect(ctx.runChild).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.objectContaining({
                    wake: {
                        trigger: 'child',
                        event: {
                            kind: 'child',
                            token: 'child-token',
                            childTaskId: 'child-task-1',
                            outcome: 'failed',
                            error: {
                                code: 'CHILD_WAKE_TIMEOUT',
                                message: 'Timed out waiting for child wake for token child-token.',
                            },
                            idempotencyKey: 'task-1:child:child-token',
                        },
                    },
                    idempotencyKey: 'task-1:child:child-token',
                }),
                expect.any(Object)
            );
        } finally {
            if (previousInterval === undefined) {
                delete process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS;
            } else {
                process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS = previousInterval;
            }
            if (previousMaxWait === undefined) {
                delete process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS;
            } else {
                process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS = previousMaxWait;
            }
            dateNow.mockRestore();
        }
    });

    it('converts an unrecoverable missing child wake into a readable timeout child result', async () => {
        const previousInterval = process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS;
        const previousMaxWait = process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS;
        const dateNow = jest.spyOn(Date, 'now');
        let now = 1_000;
        dateNow.mockImplementation(() => {
            now += 2_000;
            return now;
        });
        process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS = '1000';
        process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS = '1000';
        try {
            const finalizeRootRun = jest.fn(async () => undefined);
            const segmentOutputs = [
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    boundary: { kind: 'await_child', token: 'child-token' },
                    taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
                },
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    boundary: {
                        kind: 'complete',
                        result: {
                            ok: false,
                            error: {
                                code: 'CHILD_WAKE_TIMEOUT',
                                message: 'Timed out waiting for child wake for token child-token.',
                            },
                        },
                    },
                    taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
                },
            ];
            const ctx = {
                runChild: jest.fn(async () => segmentOutputs.shift()),
                runNoWaitChild: jest.fn(async () => undefined),
                waitFor: jest.fn(async () => ({ watchdog: {} })),
            };
            const wMEvent = {
                findMany: jest.fn(async (args: { where: { sessionId: string; type: { in: string[] } } }) => {
                    if (args.where.sessionId === 'task-1' && args.where.type.in.includes('task.child_started')) {
                        return [{
                            eventId: 'child-started-1',
                            tenantId: 'tenant-1',
                            sessionId: 'task-1',
                            seq: 2,
                            type: 'task.child_started',
                            payload: {
                                token: 'child-token',
                                childTaskId: 'child-task-1',
                                agentId: 'fetch-html',
                            },
                            createdAt: new Date('2026-06-19T00:00:00.000Z'),
                        }];
                    }
                    return [];
                }),
            };

            await executeTaskTask(
                {
                    tenantId: 'tenant-1',
                    taskId: 'task-1',
                    agentId: 'agent-1',
                    input: { value: 'hello' },
                    idempotencyKey: 'task-1:start',
                },
                ctx as never,
                {
                    driverRuns: { finalizeRootRun } as never,
                    prisma: {
                        outbox: { findMany: jest.fn(async () => []) },
                        wMEvent,
                    } as never,
                }
            );

            expect(ctx.runChild).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.objectContaining({
                    wake: {
                        trigger: 'child',
                        event: {
                            kind: 'child',
                            token: 'child-token',
                            childTaskId: 'child-task-1',
                            outcome: 'failed',
                            error: {
                                code: 'CHILD_WAKE_TIMEOUT',
                                message: 'Timed out waiting for child wake for token child-token.',
                            },
                            idempotencyKey: 'task-1:child:child-token',
                        },
                    },
                    idempotencyKey: 'task-1:child:child-token',
                }),
                expect.any(Object)
            );
            expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                status: 'failed',
                boundaryKind: 'complete',
                error: expect.objectContaining({
                    code: 'CHILD_WAKE_TIMEOUT',
                    message: 'Timed out waiting for child wake for token child-token.',
                }),
            }));
        } finally {
            dateNow.mockRestore();
            if (previousInterval === undefined) {
                delete process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS;
            } else {
                process.env.CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS = previousInterval;
            }
            if (previousMaxWait === undefined) {
                delete process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS;
            } else {
                process.env.CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS = previousMaxWait;
            }
        }
    });

    it('resumes await_child from an already persisted child failure as an ok:false child wake', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-token' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: {
                    kind: 'complete',
                    result: {
                        ok: false,
                        error: { code: 'CHILD_FAILED', message: 'Child failed' },
                    },
                },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:01.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitForEvent: jest.fn(async () => {
                throw new Error('should not wait');
            }),
        };
        const wMEvent = {
            findMany: jest.fn(async () => [{
                eventId: 'event-1',
                tenantId: 'tenant-1',
                sessionId: 'task-1',
                seq: 2,
                type: 'task.child_failed',
                payload: {
                    token: 'child-token',
                    childTaskId: 'child-task-1',
                    error: { code: 'ALL_MODES_FAILED', message: 'No HTML returned' },
                },
                createdAt: new Date('2026-06-19T00:00:00.500Z'),
            }]),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                } as never,
            }
        );

        expect(ctx.waitForEvent).not.toHaveBeenCalled();
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: {
                    trigger: 'child',
                    event: {
                        kind: 'child',
                        token: 'child-token',
                        childTaskId: 'child-task-1',
                        outcome: 'failed',
                        error: { code: 'ALL_MODES_FAILED', message: 'No HTML returned' },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'failed',
            boundaryKind: 'complete',
        }));
    });

    it('ignores persisted completions for other child tokens until the parent awaits that token', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const segmentOutputs = [
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-a' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-b' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:01.000Z' },
            },
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'complete', result: { ok: true } },
                taskStatus: { state: 'completed', timestamp: '2026-06-19T00:00:02.000Z' },
            },
        ];
        const ctx = {
            runChild: jest.fn(async () => segmentOutputs.shift()),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => ({
                child: {
                    event1: {
                        tenantId: 'tenant-1',
                        taskId: 'task-1',
                        kind: 'child',
                        token: 'child-a',
                        childTaskId: 'child-task-a',
                        output: { ok: true, child: 'a' },
                    },
                },
            })),
        };
        const wMEvent = {
            findMany: jest.fn(async () => [{
                eventId: 'event-b',
                tenantId: 'tenant-1',
                sessionId: 'task-1',
                seq: 2,
                type: 'task.child_completed',
                payload: {
                    token: 'child-b',
                    childTaskId: 'child-task-b',
                    resultPreview: { ok: true, child: 'b' },
                },
                createdAt: new Date('2026-06-19T00:00:00.500Z'),
            }]),
        };

        await executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            {
                driverRuns: { finalizeRootRun } as never,
                prisma: {
                    outbox: { findMany: jest.fn(async () => []) },
                    wMEvent,
                } as never,
            }
        );

        expect(ctx.waitFor).toHaveBeenCalledTimes(1);
        expect(ctx.waitFor).toHaveBeenCalledWith(expect.any(Object), 'wait:child-or-watchdog:child-a:0');
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.objectContaining({
                wake: expect.objectContaining({
                    event: expect.objectContaining({
                        token: 'child-a',
                        childTaskId: 'child-task-a',
                    }),
                }),
            }),
            expect.any(Object)
        );
        expect(ctx.runChild).toHaveBeenNthCalledWith(
            3,
            expect.any(String),
            expect.objectContaining({
                wake: expect.objectContaining({
                    event: expect.objectContaining({
                        token: 'child-b',
                        childTaskId: 'child-task-b',
                        output: { ok: true, child: 'b' },
                    }),
                }),
            }),
            expect.any(Object)
        );
        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
        }));
    });

    it('marks the root driver run failed when waiting for a boundary throws', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const ctx = {
            runChild: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                boundary: { kind: 'await_child', token: 'child-token' },
                taskStatus: { state: 'working', timestamp: '2026-06-19T00:00:00.000Z' },
            })),
            runNoWaitChild: jest.fn(async () => undefined),
            waitFor: jest.fn(async () => {
                throw new Error('execution timeout');
            }),
        };

        await expect(executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        )).rejects.toThrow('execution timeout');

        expect(finalizeRootRun).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'failed',
            agentId: 'agent-1',
            boundaryKind: 'fail',
            error: expect.objectContaining({ message: 'execution timeout' }),
        }));
    });

    it('does not mark the root failed for Hatchet durable eviction aborts', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const abort = new Error('Operation cancelled by AbortSignal');
        abort.name = 'AbortError';
        abort.stack = [
            'AbortError: Operation cancelled by AbortSignal',
            '    at DurableEvictionManager.cancelLocal (/worker-internal.js:363:45)',
            '    at DurableEvictionManager._evictRun (/eviction-manager.js:57:14)',
        ].join('\n');
        const ctx = {
            runChild: jest.fn(async () => {
                throw abort;
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };

        await expect(executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never }
        )).rejects.toThrow('Operation cancelled by AbortSignal');

        expect(finalizeRootRun).not.toHaveBeenCalled();
    });

    it('marks the root canceled when a provider abort follows operator cancellation metadata', async () => {
        const finalizeRootRun = jest.fn(async () => undefined);
        const abort = new Error('Operation cancelled by AbortSignal');
        abort.name = 'AbortError';
        abort.stack = [
            'AbortError: Operation cancelled by AbortSignal',
            '    at InternalWorker.<anonymous> (/worker-internal.js:606:45)',
        ].join('\n');
        const ctx = {
            runChild: jest.fn(async () => {
                throw abort;
            }),
            runNoWaitChild: jest.fn(async () => undefined),
        };
        const prisma = {
            wMSession: {
                findUnique: jest.fn(async () => ({
                    snapshot: {
                        meta: {
                            cancellation: {
                                requested: true,
                                reason: 'operator stop',
                                requestedAt: '2026-06-23T00:00:00.000Z',
                            },
                        },
                    },
                })),
            },
        };

        await expect(executeTaskTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                input: { value: 'hello' },
                idempotencyKey: 'task-1:start',
            },
            ctx as never,
            { driverRuns: { finalizeRootRun } as never, prisma: prisma as never }
        )).rejects.toThrow('Operation cancelled by AbortSignal');

        expect(finalizeRootRun).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'canceled',
            agentId: 'agent-1',
            boundaryKind: 'canceled',
        });
    });
});
