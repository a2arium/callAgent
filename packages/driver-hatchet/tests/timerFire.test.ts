import { describe, expect, it, jest } from '@jest/globals';
import { createTimerFireTask, executeTimerFireTask } from '../src/tasks/timerFire.js';

describe('executeTimerFireTask', () => {
    it('declares timer fire tasks with retries and timeout', () => {
        const task = jest.fn((options: unknown) => options);

        createTimerFireTask({ task } as never, {
            runtimeTimers: {} as never,
        });

        expect(task).toHaveBeenCalledWith(expect.objectContaining({
            name: 'aplret.timer.fire',
            retries: 3,
            executionTimeout: '5m',
        }));
    });

    it('pushes one timer wake after acquiring the timer lease', async () => {
        const now = new Date('2026-06-23T00:00:00.000Z');
        const timer = {
            id: 'row-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            rootTaskId: 'task-1',
            token: 'tok-1',
            timerId: 'timer-1',
            dueAt: now,
            kind: 'token_expiry',
            status: 'firing',
            idempotencyKey: 'timer:tenant-1:task-1:tok-1:timer-1',
            fireLeaseId: 'lease-1',
            fireLeaseUntil: new Date(now.getTime() + 60_000),
            payload: { timeout: true },
            providerRunId: null,
            providerTaskRunId: null,
            error: null,
            firedAt: null,
            canceledAt: null,
            createdAt: now,
            updatedAt: now,
        };
        const runtimeTimers = {
            acquireFireLease: jest.fn(async () => ({ timer, fireLeaseId: 'lease-1' })),
            markFired: jest.fn(async () => true),
        };
        const events = {
            push: jest.fn(async () => undefined),
        };
        const driverRuns = {
            upsertByProviderRunId: jest.fn(async () => undefined),
        };
        const ctx = {
            workflowRunId: () => 'run-1',
            taskRunExternalId: () => 'task-run-1',
        };

        await executeTimerFireTask(
            {
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
                token: 'tok-1',
                timerId: 'timer-1',
                idempotencyKey: 'timer:tenant-1:task-1:tok-1:timer-1',
            },
            ctx as never,
            {
                runtimeTimers: runtimeTimers as never,
                events,
                driverRuns: driverRuns as never,
            }
        );

        expect(events.push).toHaveBeenCalledWith(
            'aplret.timer.tok-1',
            expect.objectContaining({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                kind: 'timer',
                token: 'tok-1',
                timerId: 'timer-1',
                reason: 'input_timeout',
            }),
            { key: 'tenant-1:task-1:timer:timer-1' }
        );
        expect(runtimeTimers.markFired).toHaveBeenCalledWith(expect.objectContaining({
            id: 'row-1',
            fireLeaseId: 'lease-1',
        }));
        expect(driverRuns.upsertByProviderRunId).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'timer.fire',
            status: 'completed',
        }));
    });
});
