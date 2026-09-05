import { describe, expect, it, jest } from '@jest/globals';
import type { RunSegmentParams, SegmentResult, TurnExecutor } from '@a2arium/callagent-core/unstable';
import {
    HatchetExecutionSupervisor,
    HatchetWorkerStreamUnavailableError,
} from '../src/hatchetExecutionSupervisor.js';

const params = {
    tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
    wake: { trigger: 'start', input: {} }, idempotencyKey: 'task-1:start',
} as RunSegmentParams;

describe('HatchetExecutionSupervisor', () => {
    it('aborts active segments and rejects new admission', async () => {
        let observedSignal: AbortSignal | undefined;
        const delegate: TurnExecutor = {
            runSegment: jest.fn(async (input: RunSegmentParams) => {
                observedSignal = input.abortSignal;
                await new Promise<void>((_resolve, reject) => {
                    input.abortSignal?.addEventListener('abort', () => reject(input.abortSignal?.reason), { once: true });
                });
                throw new Error('unreachable');
            }),
        };
        const supervisor = new HatchetExecutionSupervisor(delegate);
        const running = supervisor.runSegment(params);
        await Promise.resolve();
        expect(supervisor.activeCount).toBe(1);

        const failure = new HatchetWorkerStreamUnavailableError('inactive worker');
        supervisor.abortAll(failure);

        await expect(running).rejects.toBe(failure);
        expect(observedSignal?.aborted).toBe(true);
        await expect(supervisor.runSegment(params)).rejects.toBe(failure);
        await expect(supervisor.drain(10)).resolves.toEqual({ drained: true, activeCount: 0 });
    });

    it('reports a bounded drain timeout for callbacks that ignore cancellation', async () => {
        let release!: (value: SegmentResult) => void;
        const delegate: TurnExecutor = {
            runSegment: () => new Promise<SegmentResult>((resolve) => { release = resolve; }),
        };
        const supervisor = new HatchetExecutionSupervisor(delegate);
        const running = supervisor.runSegment(params);
        supervisor.abortAll(new HatchetWorkerStreamUnavailableError());

        await expect(supervisor.drain(5)).resolves.toMatchObject({ drained: false, activeCount: 1 });
        release({
            tenantId: 'tenant-1', taskId: 'task-1',
            boundary: { kind: 'paused', reason: 'test' }, taskStatus: 'working',
        });
        await running;
        await expect(supervisor.drain(5)).resolves.toEqual({ drained: true, activeCount: 0 });
    });
});
