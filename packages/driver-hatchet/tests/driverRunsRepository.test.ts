import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@a2arium/callagent-memory-sql/generated';
import { DriverRunsRepository } from '../src/driverRunsRepository.js';

describe('DriverRunsRepository', () => {
    it('clears stale errors when a provider run updates to a non-failed status', async () => {
        const upsert = jest.fn(async () => undefined);
        const repo = new DriverRunsRepository({
            driverRun: {
                upsert,
            },
        } as never);

        await repo.upsertByProviderRunId({
            providerRunId: 'provider-run-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            operation: 'agent.run',
            status: 'completed',
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                status: 'completed',
                error: Prisma.JsonNull,
            }),
        }));
    });

    it('preserves stale errors when a failed update does not provide a replacement error', async () => {
        const upsert = jest.fn(async () => undefined);
        const repo = new DriverRunsRepository({
            driverRun: {
                upsert,
            },
        } as never);

        await repo.upsertByProviderRunId({
            providerRunId: 'provider-run-1',
            tenantId: 'tenant-1',
            taskId: 'task-1',
            operation: 'agent.run',
            status: 'failed',
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                status: 'failed',
                error: undefined,
            }),
        }));
    });

    it('clears stale root errors when finalizing to a non-failed status', async () => {
        const updateMany = jest.fn(async () => undefined);
        const repo = new DriverRunsRepository({
            driverRun: {
                updateMany,
            },
        } as never);

        await repo.finalizeRootRun({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            status: 'completed',
        });

        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'completed',
                error: Prisma.JsonNull,
            }),
        }));
    });
});
