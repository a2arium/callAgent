import { jest } from '@jest/globals';
import { HatchetScheduleReadiness, gateScheduleService } from '../src/host.js';

describe('HatchetScheduleReadiness', () => {
    afterEach(() => jest.useRealTimers());

    it('becomes healthy after an authenticated probe succeeds', async () => {
        const readiness = new HatchetScheduleReadiness(async () => undefined);
        readiness.start();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(readiness.isHealthy()).toBe(true);
        readiness.stop();
    });

    it('stays degraded after failure and recovers on retry', async () => {
        jest.useFakeTimers();
        const probe = jest.fn()
            .mockRejectedValueOnce(new Error('unauthorized endpoint'))
            .mockResolvedValue(undefined);
        const readiness = new HatchetScheduleReadiness(probe);
        readiness.start();
        await Promise.resolve();
        await Promise.resolve();
        expect(readiness.isHealthy()).toBe(false);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(readiness.isHealthy()).toBe(true);
        readiness.stop();
    });

    it('rejects schedule operations with a retryable provider error while degraded', async () => {
        const readiness = new HatchetScheduleReadiness(async () => { throw new Error('down'); });
        const service = gateScheduleService({ list: jest.fn() } as never, readiness);
        await expect(Promise.resolve().then(() => service.list({ tenantId: 't', actorId: 'a', actorType: 'service', production: true, role: 'viewer' })))
            .rejects.toMatchObject({ code: 'SCHEDULE_PROVIDER_UNAVAILABLE', status: 503 });
    });
});
