import { describe, it, expect, jest } from '@jest/globals';
import { HatchetRuntimeDriver } from '../src/hatchetRuntimeDriver.js';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';

describe('HatchetRuntimeDriver', () => {
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
});
