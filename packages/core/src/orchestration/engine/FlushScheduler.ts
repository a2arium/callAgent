
import { logger } from '@a2arium/callagent-utils';
import type { TaskContext } from '../../shared/types/index.js';

const log = logger.createLogger({ prefix: 'FlushScheduler' });

/**
 * Schedules and coalesces flush operations to prevent excessive writes.
 */
export class FlushScheduler {
    // Stores the REAL promise for the pending flush so subsequent callers await the actual work.
    private pendingFlushes = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }>();
    private lastFlushTime = new Map<string, number>();
    private readonly MIN_FLUSH_INTERVAL_MS = 50; // Minimum interval between flushes for the same key

    /**
     * Coalesce a flush operation. If a flush is pending, returns the pending promise.
     * If recently flushed, delays the new flush (debounce).
     */
    async coalesce(key: string, flushFn: () => Promise<void>, ctx: TaskContext, agentId: string): Promise<void> {
        const now = Date.now();
        const lastFlush = this.lastFlushTime.get(key) || 0;

        // If a flush is already truly pending for this key, return its promise
        if (this.pendingFlushes.has(key)) {
            log.debug(`FlushScheduler: Coalescing flush for key ${key}. Returning existing promise.`);
            return this.pendingFlushes.get(key)!.promise;
        }

        // Check if we need to debounce
        if (now - lastFlush < this.MIN_FLUSH_INTERVAL_MS) {
            log.debug(`FlushScheduler: Debouncing flush for key ${key}. Last flush ${now - lastFlush}ms ago.`);

            // Create a controlled promise that subsequent callers will also await
            let resolve: () => void;
            let reject: (err: Error) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });

            // Store it IMMEDIATELY so concurrent calls find it
            this.pendingFlushes.set(key, { promise, resolve: resolve!, reject: reject! });

            const delay = this.MIN_FLUSH_INTERVAL_MS - (now - lastFlush);

            // Schedule the actual execution
            setTimeout(async () => {
                try {
                    await this._executeFlush(key, flushFn, ctx, agentId);
                    // The _executeFlush removes the map entry, but we need to resolve the promise we gave out.
                    // Note: _executeFlush creates its OWN internal promise logic if called directly, 
                    // but here we are wrapping it.
                    // Actually, _executeFlush logic below is designed to be self-contained for map management.
                    // Let's rely on _executeFlush to run the fn, but WE manage the promise resolution for the debouncer.
                    resolve!();
                } catch (err: any) {
                    reject!(err);
                }
            }, delay);

            return promise;
        }

        // Otherwise, execute immediately
        log.debug(`FlushScheduler: Executing immediate flush for key ${key}.`);
        return this._executeFlush(key, flushFn, ctx, agentId);
    }

    private async _executeFlush(key: string, flushFn: () => Promise<void>, ctx: TaskContext, agentId: string): Promise<void> {
        // If we are called directly (not via debounce), we need to register ourselves 
        // IF we aren't already registered (debounce path registers before calling this if it wants to reuse this logic, 
        // but arguably debounce path should just call the body).
        // Let's make _executeFlush the authoritative runner that manages the map if not present.

        let resolve: () => void;
        let reject: (err: Error) => void;

        // If entry exists, it means we are running the WORK for a previously registered promise (debounce case)
        // OR we are recursively re-entering? No.
        // Simplified approach: _executeFlush always runs the work. 
        // If there is no entry in map, we create one to block others during execution.

        const existing = this.pendingFlushes.get(key);
        if (!existing) {
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.pendingFlushes.set(key, { promise, resolve: resolve!, reject: reject! });
        }

        try {
            log.debug(`FlushScheduler: Starting flush for key ${key}`);
            await flushFn();
            this.lastFlushTime.set(key, Date.now());
            log.debug(`FlushScheduler: Completed flush for key ${key}`);

            if (existing) {
                // If it was pre-existing (debounce), the caller of _executeFlush handles resolution? 
                // Wait, if we use the same helper for both, we need to be careful.
                // In my debounce logic above, I awaited _executeFlush. 
                // So _executeFlush should probably NOT resolve the map promise if it didn't create it?
                // actually, standard pattern: _executeFlush does the work and cleanup.
            }

            // Resolve the promise in the map (whether we created it or debounce did)
            this.pendingFlushes.get(key)?.resolve();
        } catch (err: any) {
            log.error(`FlushScheduler: Flush failed for key ${key}: ${err.message}`);
            this.pendingFlushes.get(key)?.reject(err);
            throw err; // Re-throw for specific caller
        } finally {
            this.pendingFlushes.delete(key);
        }
    }
}
