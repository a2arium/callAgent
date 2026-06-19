import { afterEach, describe, it, expect, jest } from '@jest/globals';
import { HatchetRuntimeDriver } from '../src/hatchetRuntimeDriver.js';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';

describe('HatchetRuntimeDriver', () => {
    afterEach(() => {
        delete process.env.CALLAGENT_DRIVER_SURFACES;
    });

    it('delegates scheduling methods to the in-process driver', async () => {
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

        await driver.enqueueStart({
            tenantId: 't',
            taskId: 'task',
            idempotencyKey: 'k',
            input: {},
        });
        expect(delegate.enqueueStart).toHaveBeenCalled();

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

    it('enqueues aplret.task for start when the start surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'start';
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
            }),
            expect.objectContaining({
                additionalMetadata: expect.objectContaining({
                    tenantTaskKey: 'tenant-1:task-1',
                }),
            })
        );
    });

    it('pushes resume events when the resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
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
        };
        const bus = { publish: jest.fn(async () => undefined) };
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => row),
                delete: jest.fn(async () => undefined),
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
        expect(prisma.outbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('uses an agent-named parent workflow when registered', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'start';
        const delegate: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const fallbackTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('fallback-run') })),
        };
        const agentTask = {
            runNoWait: jest.fn(async () => ({ runId: Promise.resolve('agent-run') })),
        };
        const driver = new HatchetRuntimeDriver(
            delegate,
            { runNoWait: jest.fn() } as never,
            undefined,
            undefined,
            fallbackTask as never,
            new Map([['agent-1', agentTask as never]])
        );

        await driver.enqueueStart({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            idempotencyKey: 'task-1:start',
            input: { text: 'hello' },
        });

        expect(agentTask.runNoWait).toHaveBeenCalled();
        expect(fallbackTask.runNoWait).not.toHaveBeenCalled();
    });
});
