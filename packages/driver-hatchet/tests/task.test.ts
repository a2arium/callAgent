import { describe, expect, it, jest } from '@jest/globals';
import { executeTaskTask } from '../src/tasks/task.js';

describe('executeTaskTask', () => {
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
});
