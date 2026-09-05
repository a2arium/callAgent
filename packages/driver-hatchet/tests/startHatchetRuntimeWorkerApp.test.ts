import { describe, expect, it, jest } from '@jest/globals';
import {
    resolveWorkerShutdownGraceMs,
    startHatchetWorkerUntilReady,
} from '../src/startHatchetRuntimeWorkerApp.js';

describe('startHatchetWorkerUntilReady', () => {
    it('reports ready without waiting for Hatchet’s long-lived start loop to end', async () => {
        let finishWorker!: () => void;
        const workerRun = new Promise<void>((resolve) => { finishWorker = resolve; });
        const worker = {
            start: jest.fn(() => workerRun),
            stop: jest.fn(async () => undefined),
            waitUntilReady: jest.fn(async () => undefined),
        };

        const { workerRun: running } = await startHatchetWorkerUntilReady(worker);

        expect(worker.start).toHaveBeenCalledTimes(1);
        expect(worker.waitUntilReady).toHaveBeenCalledWith(30_000);
        let settled = false;
        void running.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        finishWorker();
        await running;
        expect(settled).toBe(true);
    });
});

describe('resolveWorkerShutdownGraceMs', () => {
    it('defaults to thirty seconds and accepts a positive override', () => {
        expect(resolveWorkerShutdownGraceMs({})).toBe(30_000);
        expect(resolveWorkerShutdownGraceMs({ CALLAGENT_WORKER_SHUTDOWN_GRACE_MS: '45000' })).toBe(45_000);
    });

    it('rejects invalid shutdown deadlines', () => {
        expect(() => resolveWorkerShutdownGraceMs({ CALLAGENT_WORKER_SHUTDOWN_GRACE_MS: '0' }))
            .toThrow('must be a positive integer');
        expect(() => resolveWorkerShutdownGraceMs({ CALLAGENT_WORKER_SHUTDOWN_GRACE_MS: 'later' }))
            .toThrow('must be a positive integer');
    });
});
