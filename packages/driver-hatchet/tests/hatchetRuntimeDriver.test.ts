import { afterEach, describe, it, expect, jest } from '@jest/globals';
import { HatchetRuntimeDriver } from '../src/hatchetRuntimeDriver.js';
import { rejectObsoleteRuntimeConfiguration } from '../src/createHatchetOutboxStack.js';
import { defaultMetricsRegistry, type RuntimeDriver } from '@a2arium/callagent-core/unstable';

describe('HatchetRuntimeDriver', () => {
    const previousHatchetPayloadBudget = process.env.CALLAGENT_HATCHET_PAYLOAD_MAX_BYTES;

    afterEach(() => {
        defaultMetricsRegistry.reset();
        delete process.env.CALLAGENT_DRIVER_SURFACES;
        delete process.env.CALLAGENT_HATCHET_RUNTIME_PROTOCOL_VERSION;
        if (previousHatchetPayloadBudget === undefined) {
            delete process.env.CALLAGENT_HATCHET_PAYLOAD_MAX_BYTES;
        } else {
            process.env.CALLAGENT_HATCHET_PAYLOAD_MAX_BYTES = previousHatchetPayloadBudget;
        }
    });

    it('rejects the obsolete per-surface runtime router at bootstrap', () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'start,resume';
        expect(() => rejectObsoleteRuntimeConfiguration()).toThrow(
            'CALLAGENT_DRIVER_SURFACES is obsolete'
        );
    });

    it('rejects loop start when the Hatchet task workflow is missing', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const outboxDispatchTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('run-1') })),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            outboxDispatchTask as never,
            undefined
        );

        await expect(driver.enqueueStart({
            tenantId: 't', taskId: 'task', idempotencyKey: 'k', input: {},
        })).rejects.toThrow('HATCHET_RUNTIME_MISCONFIGURED');
        expect(delegate.enqueueStart).not.toHaveBeenCalled();

        await driver.dispatchOutbox({
            outboxRowId: 'row-1',
            eventType: 'task.status',
            tenantId: 't',
            taskId: 'task',
        });
        expect(outboxDispatchTask.runNoWait).toHaveBeenCalledWith(
            {
                outboxRowId: 'row-1',
                eventType: 'task.status',
                tenantId: 't',
                taskId: 'task',
            },
            expect.objectContaining({
                additionalMetadata: expect.objectContaining({
                    tenantTaskKey: 't:task',
                }),
            })
        );
    });

    it('exposes the delegate for idle draining', () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(delegate, { runNoWait: jest.fn() } as never);
        expect(driver.getDelegate()).toBe(delegate);
    });

    it('cancels active Hatchet provider runs best-effort after delegate cancellation', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const driverRuns = {
            findCancelableProviderRunIds: jest.fn(async () => ['run-1', 'run-2']),
            markProviderRunsCanceled: jest.fn(async () => undefined),
        };
        const runs = {
            cancel: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            driverRuns as never,
            undefined,
            undefined,
            undefined,
            runs
        );

        await driver.cancel({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:cancel',
            reason: 'operator stop',
        });

        expect(delegate.cancel).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
        }));
        expect(driverRuns.findCancelableProviderRunIds).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            taskId: 'task-1',
        });
        expect(runs.cancel).toHaveBeenCalledWith({ ids: ['run-1', 'run-2'] });
        expect(driverRuns.markProviderRunsCanceled).toHaveBeenCalledWith(['run-1', 'run-2']);
    });

    it('does not fail cancellation when Hatchet provider cancellation fails', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const driverRuns = {
            findCancelableProviderRunIds: jest.fn(async () => ['run-1']),
            markProviderRunsCanceled: jest.fn(async () => undefined),
        };
        const runs = {
            cancel: jest.fn(async () => {
                throw new Error('hatchet unavailable');
            }),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            driverRuns as never,
            undefined,
            undefined,
            undefined,
            runs
        );

        await expect(driver.cancel({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            idempotencyKey: 'task-1:cancel',
            reason: 'operator stop',
        })).resolves.toBeUndefined();

        expect(delegate.cancel).toHaveBeenCalled();
        expect(runs.cancel).toHaveBeenCalledWith({ ids: ['run-1'] });
        expect(driverRuns.markProviderRunsCanceled).not.toHaveBeenCalled();
    });

    it('enqueues aplret.task for start when the start surface is enabled', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const taskTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('task-run-1') })),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            taskTask as never
        );

        await driver.enqueueStart({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:start',
            input: { text: 'hello' },
        });

        expect(delegate.enqueueStart).not.toHaveBeenCalled();
        expect(taskTask.runNoWait).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                idempotencyKey: 'task-1:start',
                rootTaskId: 'task-1',
                tenantTaskKey: '8:tenant-1:6:task-1',
                rootRunKey: '8:tenant-1:6:task-1:root:1',
            }),
            expect.objectContaining({
                additionalMetadata: expect.objectContaining({
                    tenantTaskKey: 'tenant-1:task-1',
                }),
            })
        );
    });

    it('pushes resume events when the resume surface is enabled', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const events = {
            push: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            undefined,
            events
        );

        await driver.enqueueResume({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            idempotencyKey: 'task-1:input:tok-1',
            event: { kind: 'input', token: 'tok-1', value: 'answer' },
        });

        expect(delegate.enqueueResume).not.toHaveBeenCalled();
        expect(events.push).toHaveBeenCalledWith(
            'aplret.input.tok-1',
            expect.objectContaining({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'input',
                token: 'tok-1',
                value: 'answer',
            }),
            { key: 'tenant-1:task-1:tok-1' }
        );
    });

    it('pushes external resume events when the resume surface is enabled', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const events = {
            push: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            undefined,
            events
        );

        await driver.enqueueResume({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            idempotencyKey: 'task-1:external:tok-1',
            event: { kind: 'external', token: 'tok-1', type: 'webhook.received', data: { ok: true } },
        });

        expect(delegate.enqueueResume).not.toHaveBeenCalled();
        expect(events.push).toHaveBeenCalledWith(
            'aplret.external.tok-1',
            expect.objectContaining({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'external',
                token: 'tok-1',
                type: 'webhook.received',
                data: { ok: true },
            }),
            { key: 'tenant-1:task-1:tok-1' }
        );
    });

    it('publishes conversation resume events through the durable Hatchet root', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const events = {
            push: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            undefined,
            events
        );

        await driver.enqueueResume({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            idempotencyKey: 'task-1:conversation:msg-1',
            event: {
                kind: 'conversation',
                token: 'task-1',
                messageId: 'msg-1',
                data: { kind: 'message.received' },
            },
        });

        expect(events.push).toHaveBeenCalledWith(
            'aplret.conversation.task-1',
            expect.objectContaining({ tenantId: 'tenant-1', taskId: 'task-1', kind: 'conversation' }),
            { key: 'tenant-1:task-1:task-1' }
        );
        expect(delegate.enqueueResume).not.toHaveBeenCalled();
    });

    it('persists timers when the timers surface is enabled', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'delegate-timer' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const timer = {
            id: 'runtime-timer-row-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            rootTaskId: 'task-1',
            token: 'tok-1',
            timerId: 'timer-stable',
            dueAt: new Date(Date.now() + 60_000),
            kind: 'token_expiry',
            status: 'scheduled',
            idempotencyKey: 'timer:tenant-1:task-1:tok-1:timer-stable',
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
        const runtimeTimers = {
            schedule: jest.fn(async () => timer),
        };
        const driverRuns = {
            upsertByProviderRunId: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            driverRuns as never,
            undefined,
            undefined,
            undefined,
            undefined,
            runtimeTimers as never
        );

        const result = await driver.scheduleTimer({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            token: 'tok-1',
            fireAt: timer.dueAt.toISOString(),
            kind: 'token_expiry',
            idempotencyKey: 'ignored-by-timer-repository',
        });

        expect(result.timerId).toBe('timer-stable');
        expect(delegate.scheduleTimer).not.toHaveBeenCalled();
        expect(runtimeTimers.schedule).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'tok-1',
            kind: 'token_expiry',
        }));
        expect(driverRuns.upsertByProviderRunId).toHaveBeenCalledWith(expect.objectContaining({
            providerRunId: 'runtime-timer-row-1',
            operation: 'timer.schedule',
            status: 'completed',
            idempotencyKey: 'timer:tenant-1:task-1:tok-1:timer-stable',
        }));
    });


    it('falls back to inline dispatch when Hatchet trigger fails', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const row = {
            id: 'row-1',
            tenantId: 't',
            topic: 'task.status',
            key: 'task-1',
            payload: { taskId: 'task-1' },
            createdAt: new Date(),
            retryCount: 0,
            deliveryScope: 'shared',
        };
        const bus = { publish: jest.fn(async () => undefined) };
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => row),
                delete: jest.fn(async () => undefined),
                updateMany: jest.fn(async () => ({ count: 1 })),
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn(async () => { throw new Error('hatchet down'); }) } as never,
            undefined,
            { eventBus: bus as never, prisma }
        );

        await driver.dispatchOutbox({
            outboxRowId: 'row-1',
            eventType: 'task.status',
            tenantId: 't',
            taskId: 'task-1',
        });

        expect(bus.publish).toHaveBeenCalled();
        expect(prisma.outbox.deleteMany).toHaveBeenCalledWith({
            where: { id: 'row-1', dispatchLeaseId: expect.any(String) },
        });
    });

    it('uses only the shared aplret.task workflow regardless of agent identity', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const fallbackTask = {
            runNoWait: jest.fn(async (_input: unknown) => ({ runId: Promise.resolve('fallback-run') })),
        };
        const agentTask = {
            runNoWait: jest.fn(async (_input: unknown) => ({ runId: Promise.resolve('agent-run') })),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            fallbackTask as never
        );

        await driver.enqueueStart({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:start',
            input: { text: 'hello' },
        });

        expect(fallbackTask.runNoWait).toHaveBeenCalled();
        const submitted = fallbackTask.runNoWait.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(submitted).not.toHaveProperty('runtimeProtocolVersion');
        expect(submitted.rootRunKey).toBe('8:tenant-1:6:task-1:root:1');
        expect(agentTask.runNoWait).not.toHaveBeenCalled();
    });

    it('records a semantic budget event before throwing on oversized Hatchet start payloads', async () => {
        process.env.CALLAGENT_HATCHET_PAYLOAD_MAX_BYTES = '220';
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const taskTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('agent-run') })),
        };
        const budgetEvents = {
            appendBudgetExceededEvent: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            taskTask as never,
            undefined,
            undefined,
            undefined,
            undefined,
            budgetEvents
        );

        await expect(driver.enqueueStart({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:start',
            input: { html: 'x'.repeat(1000) },
        })).rejects.toThrow('LIMIT_HATCHET_PAYLOAD_TOO_LARGE');

        expect(taskTask.runNoWait).not.toHaveBeenCalled();
        expect(budgetEvents.appendBudgetExceededEvent).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            sessionId: 'task-1',
            taskId: 'task-1',
            code: 'LIMIT_HATCHET_PAYLOAD_TOO_LARGE',
            eventType: 'agent.run',
        }));
        expect(defaultMetricsRegistry.snapshot().counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'payload.budget_failure_total',
                count: 1,
                dimensions: expect.objectContaining({
                    surface: 'hatchet.task_payload',
                    operation: 'agent.run',
                    code: 'LIMIT_HATCHET_PAYLOAD_TOO_LARGE',
                }),
            }),
        ]));
    });

    it('records provider enqueue failures as metrics and semantic incidents', async () => {
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const taskTask = {
            runNoWait: jest.fn(async () => {
                throw new Error('hatchet unavailable');
            }),
        };
        const budgetEvents = {
            appendBudgetExceededEvent: jest.fn(async () => undefined),
            appendIncidentEvent: jest.fn(async () => undefined),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            taskTask as never,
            undefined,
            undefined,
            undefined,
            undefined,
            budgetEvents
        );

        await expect(driver.enqueueStart({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:start',
            input: { text: 'hello' },
        })).rejects.toThrow('hatchet unavailable');

        expect(budgetEvents.appendIncidentEvent).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            sessionId: 'task-1',
            taskId: 'task-1',
            operation: 'observability.provider_enqueue_failed',
            eventType: 'agent.run',
        }));
        expect(defaultMetricsRegistry.snapshot().counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'hatchet.enqueue_total',
                count: 1,
                dimensions: expect.objectContaining({
                    operation: 'agent.run',
                    status: 'failed',
                }),
            }),
        ]));
        expect(defaultMetricsRegistry.snapshot().counters.find((counter) => counter.name === 'hatchet.enqueue_total')?.dimensions).not.toEqual(expect.objectContaining({
            tenantId: expect.any(String),
            taskId: expect.any(String),
            agentId: expect.any(String),
        }));
    });
});
