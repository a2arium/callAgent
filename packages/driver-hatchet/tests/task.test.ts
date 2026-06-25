import { describe, expect, it, jest } from '@jest/globals';
import {
    resolveAgentHatchetExecutionTimeout,
    resolveHatchetExecutionTimeout,
    resolveSharedSegmentHatchetExecutionTimeout,
} from '../src/taskTimeouts.js';
import { createSegmentTask } from '../src/tasks/segment.js';
import { createTaskTask, executeTaskTask } from '../src/tasks/task.js';

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
                                },
                            },
                        })),
                    },
                } as never,
            }
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
                output: {
                    ok: false,
                    error: { code: 'ALL_MODES_FAILED', message: 'No content' },
                },
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
            waitForEvent: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'child',
                token: 'child-token',
                childTaskId: 'child-task-1',
                output: { ok: true },
                idempotencyKey: 'task-1:child:child-token',
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
            'aplret.child.child-token',
            'input.tenantId == "tenant-1" && input.taskId == "task-1"',
            undefined,
            undefined,
            '5m',
            'wait:child:child-token'
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
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                turnSeq: 2,
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
                turnSeq: 2,
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
                turnSeq: 2,
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
                    resultPreview: { ok: true },
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
                        output: { ok: true },
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
            waitForEvent: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'child',
                token: 'child-token',
                childTaskId: 'child-task-1',
                output: { ok: true },
                idempotencyKey: 'task-1:child:child-token',
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

        expect(ctx.waitForEvent).toHaveBeenCalledWith(
            'aplret.child.child-token',
            'input.tenantId == "tenant-1" && input.taskId == "task-1"',
            undefined,
            undefined,
            '5m',
            'wait:child:child-token'
        );
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
                        output: { ok: true },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                turnSeq: 2,
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

    it('recovers persisted child terminal output when Hatchet child wake replay is empty', async () => {
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
                if (args.where.sessionId === 'child-task-1' && types.includes('turn.completed')) {
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
                                    data: { html: '<html>ok</html>', statusCode: 200 },
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
                        output: {
                            ok: true,
                            data: { html: '<html>ok</html>', statusCode: 200 },
                        },
                        idempotencyKey: 'task-1:child:child-token',
                    },
                },
                idempotencyKey: 'task-1:child:child-token',
                turnSeq: 2,
            }),
            expect.any(Object)
        );
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
                        output: {
                            ok: false,
                            error: { code: 'ALL_MODES_FAILED', message: 'No HTML returned' },
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
            waitForEvent: jest.fn(async () => ({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'child',
                token: 'child-a',
                childTaskId: 'child-task-a',
                output: { ok: true, child: 'a' },
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

        expect(ctx.waitForEvent).toHaveBeenCalledTimes(1);
        expect(ctx.waitForEvent).toHaveBeenCalledWith(
            'aplret.child.child-a',
            'input.tenantId == "tenant-1" && input.taskId == "task-1"',
            undefined,
            undefined,
            '5m',
            'wait:child:child-a'
        );
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
            waitForEvent: jest.fn(async () => {
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
