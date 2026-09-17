import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { defaultMetricsRegistry } from '@a2arium/callagent-core/unstable';
import { withHatchetTaskLogging } from '../src/hatchetLogging.js';

describe('withHatchetTaskLogging', () => {
    afterEach(() => {
        defaultMetricsRegistry.reset();
    });

    it('records worker task metrics and does not fail when the Hatchet log sink fails', async () => {
        const ctx = {
            workflowRunId: () => 'run-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 0,
            logger: {
                info: jest.fn(async () => {
                    throw new Error('log sink down');
                }),
            },
        };

        await expect(withHatchetTaskLogging(
            { tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1' },
            ctx,
            'agent.run',
            async () => 'ok'
        )).resolves.toBe('ok');

        const snapshot = defaultMetricsRegistry.snapshot();
        expect(snapshot.counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.worker_task_total',
                count: 1,
                dimensions: expect.objectContaining({ operation: 'agent.run', status: 'started' }),
            }),
            expect.objectContaining({
                name: 'runtime.worker_task_total',
                count: 1,
                dimensions: expect.objectContaining({ operation: 'agent.run', status: 'completed' }),
            }),
            expect.objectContaining({
                name: 'observability.log_sink_failure_total',
                count: 2,
                dimensions: expect.objectContaining({ operation: 'agent.run', level: 'info' }),
            }),
        ]));
        expect(snapshot.durations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.worker_task_ms',
                dimensions: expect.objectContaining({ operation: 'agent.run', status: 'completed' }),
            }),
        ]));
    });

    it('rethrows the original task error even when failure logging also fails', async () => {
        const ctx = {
            logger: {
                info: jest.fn(async () => undefined),
                error: jest.fn(async () => {
                    throw new Error('log sink down');
                }),
            },
        };

        await expect(withHatchetTaskLogging(
            { tenantId: 'tenant-1', taskId: 'task-1' },
            ctx,
            'aplret.segment',
            async () => {
                throw new TypeError('execution failed');
            }
        )).rejects.toThrow('execution failed');

        expect(defaultMetricsRegistry.snapshot().counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.worker_task_total',
                dimensions: expect.objectContaining({
                    operation: 'aplret.segment',
                    status: 'failed',
                    errorCode: 'TypeError',
                }),
            }),
            expect.objectContaining({
                name: 'observability.log_sink_failure_total',
                dimensions: expect.objectContaining({
                    operation: 'aplret.segment',
                    level: 'error',
                }),
            }),
        ]));
    });

    it('mirrors console.log from a Hatchet task to Hatchet info logs', async () => {
        const ctx = {
            workflowRunId: () => 'run-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 0,
            logger: {
                info: jest.fn(async () => undefined),
                debug: jest.fn(async () => undefined),
                warn: jest.fn(async () => undefined),
                error: jest.fn(async () => undefined),
            },
        };

        await expect(withHatchetTaskLogging(
            { tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1' },
            ctx,
            'aplret.segment',
            async () => {
                console.log('agent log visible', { step: 'execution' });
                return 'ok';
            }
        )).resolves.toBe('ok');

        expect(ctx.logger.info).toHaveBeenCalledWith(
            expect.stringContaining('agent log visible'),
            expect.objectContaining({
                operation: 'aplret.segment',
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'agent-1',
            })
        );
    });
});
