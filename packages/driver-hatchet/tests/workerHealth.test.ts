import { describe, expect, it, jest } from '@jest/globals';
import { startWorkerHealthMonitor } from '../src/workerHealth.js';

const registeredWorkflows = [
    'aplret.outbox.dispatch',
    'aplret.task',
    'aplret.task-state',
    'aplret.segment',
    'aplret.timer.fire',
].map((name) => ({ name }));

describe('worker health monitor', () => {
    it('requires an active worker, fresh heartbeat, and all required workflows', async () => {
        const upsert = jest.fn(async () => undefined);
        const monitor = await startWorkerHealthMonitor({
            prisma: { runtimeWorkerHealth: { upsert } },
            hatchet: { workers: { list: jest.fn(async () => ({ rows: [{
                name: 'runtime-a', status: 'ACTIVE', lastHeartbeatAt: new Date().toISOString(), registeredWorkflows,
            }] })) } } as any,
            workerName: 'runtime-a',
            instanceId: 'instance-a',
            intervalMs: 60_000,
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId_installationId_instanceId: {
                    tenantId: 'default',
                    installationId: 'default',
                    instanceId: 'instance-a',
                },
            },
            create: expect.objectContaining({
                instanceId: 'instance-a',
                workerName: 'runtime-a',
                state: 'ready',
            }),
        }));
        await monitor.stop();
        expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({
            update: expect.objectContaining({ state: 'stopped' }),
        }));
    });

    it('records a failed lease when the durable registration is incomplete', async () => {
        const upsert = jest.fn(async () => undefined);
        const unavailable = jest.fn();
        const monitor = await startWorkerHealthMonitor({
            prisma: { runtimeWorkerHealth: { upsert } },
            hatchet: { workers: { list: jest.fn(async () => ({ rows: [{
                name: 'runtime-a', status: 'ACTIVE', lastHeartbeatAt: new Date().toISOString(), registeredWorkflows: [],
            }] })) } } as any,
            workerName: 'runtime-a',
            intervalMs: 60_000,
            initialRegistrationGraceMs: 0,
            onStreamUnavailable: unavailable,
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ state: 'failed', errorCode: 'HATCHET_WORKER_STREAM_UNAVAILABLE' }),
        }));
        expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('missing required workflows') }));
        await monitor.stop();
    });

    it('allows Hatchet a bounded window to publish the initial ACTIVE registration', async () => {
        const upsert = jest.fn(async () => undefined);
        const unavailable = jest.fn();
        const list = jest.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValue({ rows: [{
                name: 'runtime-a', status: 'ACTIVE', lastHeartbeatAt: new Date().toISOString(), registeredWorkflows,
            }] });
        const monitor = await startWorkerHealthMonitor({
            prisma: { runtimeWorkerHealth: { upsert } },
            hatchet: { workers: { list } } as any,
            workerName: 'runtime-a',
            intervalMs: 5,
            initialRegistrationGraceMs: 1_000,
            onStreamUnavailable: unavailable,
        });

        expect(unavailable).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ state: 'ready' }),
        }));
        expect(unavailable).not.toHaveBeenCalled();
        await monitor.stop();
    });

    it('accepts Hatchet 0.105 action registrations', async () => {
        const upsert = jest.fn(async () => undefined);
        const monitor = await startWorkerHealthMonitor({
            prisma: { runtimeWorkerHealth: { upsert } },
            hatchet: { workers: { list: jest.fn(async () => ({ rows: [{
                name: 'runtime-a',
                status: 'ACTIVE',
                lastHeartbeatAt: new Date().toISOString(),
                actions: registeredWorkflows.map(({ name }) => `${name}:${name}`),
            }] })) } } as any,
            workerName: 'runtime-a',
            intervalMs: 60_000,
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ state: 'ready' }),
        }));
        await monitor.stop();
    });
});
