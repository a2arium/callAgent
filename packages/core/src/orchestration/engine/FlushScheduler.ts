
import { logger } from '@a2arium/callagent-utils';
import type { TaskContext } from '../../shared/types/index.js';

const log = logger.createLogger({ prefix: 'FlushScheduler' });

/**
 * Schedules and coalesces flush operations to prevent excessive writes.
 */
export class FlushScheduler {
    // Store the single promise that represents both scheduling and execution. Keeping a
    // second manually-controlled promise here can turn an otherwise handled flush error
    // into an unhandled rejection.
    private pendingFlushes = new Map<string, Promise<void>>();
    private lastFlushTime = new Map<string, number>();
    private readonly MIN_FLUSH_INTERVAL_MS = 50; // Minimum interval between flushes for the same key

    /**
     * Coalesce a flush operation. If a flush is pending, returns the pending promise.
     * If recently flushed, delays the new flush (debounce).
     */
    async coalesce(key: string, flushFn: () => Promise<void>, _ctx: TaskContext, _agentId: string): Promise<void> {
        const now = Date.now();
        const lastFlush = this.lastFlushTime.get(key) || 0;

        const existing = this.pendingFlushes.get(key);
        if (existing) {
            log.debug(`FlushScheduler: Coalescing flush for key ${key}. Returning existing promise.`);
            return existing;
        }

        const delay = Math.max(0, this.MIN_FLUSH_INTERVAL_MS - (now - lastFlush));
        if (delay > 0) {
            log.debug(`FlushScheduler: Debouncing flush for key ${key}. Last flush ${now - lastFlush}ms ago.`);
        }

        const work = (async () => {
            if (delay > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
            }
            log.debug(`FlushScheduler: Starting flush for key ${key}`);
            try {
                await flushFn();
                this.lastFlushTime.set(key, Date.now());
                log.debug(`FlushScheduler: Completed flush for key ${key}`);
            } catch (error) {
                log.error(`FlushScheduler: Flush failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        })();
        const tracked = work.finally(() => {
            if (this.pendingFlushes.get(key) === tracked) {
                this.pendingFlushes.delete(key);
            }
        });
        this.pendingFlushes.set(key, tracked);
        return tracked;
    }
}
