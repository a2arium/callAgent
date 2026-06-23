import { describe, expect, it, jest } from '@jest/globals';
import {
    deriveRuntimeTimerId,
    deriveRuntimeTimerIdempotencyKey,
    RuntimeTimerRepository,
    timerKindToReason,
} from '../../src/runtime/runtimeTimer.js';

describe('runtime timer helpers', () => {
    it('derives stable timer ids from logical timer identity', () => {
        const params = {
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'token-1',
            fireAt: '2026-06-23T00:00:00.000Z',
            kind: 'token_expiry' as const,
        };

        const first = deriveRuntimeTimerId(params);
        const second = deriveRuntimeTimerId(params);

        expect(first).toBe(second);
        expect(first).toMatch(/^timer:[a-f0-9]{64}$/);
    });

    it('derives stable timer fire idempotency keys', () => {
        expect(deriveRuntimeTimerIdempotencyKey({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'token-1',
            timerId: 'timer:abc',
        })).toBe('timer:tenant-1:task-1:token-1:timer:abc');
    });

    it('maps timer kinds to timer expired reasons', () => {
        expect(timerKindToReason('token_expiry')).toBe('input_timeout');
        expect(timerKindToReason('sleep')).toBe('sleep_due');
    });

    it('does not reopen fired timers when schedule is replayed', async () => {
        const fired = {
            id: 'row-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            agentId: null,
            rootTaskId: 'task-1',
            token: 'token-1',
            timerId: deriveRuntimeTimerId({
                tenantId: 'tenant-1',
                taskId: 'task-1',
                token: 'token-1',
                fireAt: '2026-06-23T00:00:00.000Z',
                kind: 'token_expiry',
            }),
            dueAt: new Date('2026-06-23T00:00:00.000Z'),
            kind: 'token_expiry',
            status: 'fired',
            idempotencyKey: '',
            fireLeaseId: null,
            fireLeaseUntil: null,
            payload: null,
            providerRunId: null,
            providerTaskRunId: null,
            error: null,
            firedAt: new Date('2026-06-23T00:00:01.000Z'),
            canceledAt: null,
            createdAt: new Date('2026-06-23T00:00:00.000Z'),
            updatedAt: new Date('2026-06-23T00:00:01.000Z'),
        };
        fired.idempotencyKey = deriveRuntimeTimerIdempotencyKey({
            tenantId: fired.tenantId,
            taskId: fired.taskId,
            token: fired.token,
            timerId: fired.timerId,
        });
        const upsert = jest.fn();
        const repository = new RuntimeTimerRepository({
            runtimeTimer: {
                findFirst: jest.fn(async () => fired),
                upsert,
                updateMany: jest.fn(),
                update: jest.fn(),
                findMany: jest.fn(),
            },
        } as never);

        const scheduled = await repository.schedule({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            token: 'token-1',
            idempotencyKey: 'ignored',
            fireAt: '2026-06-23T00:00:00.000Z',
            kind: 'token_expiry',
        });

        expect(scheduled.status).toBe('fired');
        expect(upsert).not.toHaveBeenCalled();
    });
});
