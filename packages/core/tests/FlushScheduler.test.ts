import { describe, expect, it, jest } from '@jest/globals';
import { FlushScheduler } from '../src/orchestration/engine/FlushScheduler.js';

describe('FlushScheduler', () => {
    it('propagates one handled rejection without creating an orphan promise', async () => {
        const scheduler = new FlushScheduler();
        const failure = new Error('flush superseded');
        const flush = jest.fn<() => Promise<void>>().mockRejectedValue(failure);

        await expect(scheduler.coalesce('task-a', flush, {} as any, 'agent-a')).rejects.toBe(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(flush).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent callers onto the same execution', async () => {
        const scheduler = new FlushScheduler();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const flush = jest.fn(async () => gate);

        const first = scheduler.coalesce('task-a', flush, {} as any, 'agent-a');
        const second = scheduler.coalesce('task-a', flush, {} as any, 'agent-a');
        release();
        await Promise.all([first, second]);

        expect(flush).toHaveBeenCalledTimes(1);
    });
});
