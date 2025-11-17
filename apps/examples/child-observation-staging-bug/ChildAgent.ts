import { createAgent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'ChildAgent' });

export default createAgent({
    manifest: {
        name: 'child-observation-staging-bug-child',
        version: '0.1.0',
        cache: {
            enabled: true,
            ttlSeconds: 3600  // Cache for an hour to ensure cache hits
        }
    },

    async handleTask(ctx) {
        const input = ctx.task.input as { message?: string };
        const message = input?.message || 'default';

        log.info('[ChildAgent] Processing request', { message });

        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));

        const result = {
            ok: true,
            data: {
                message,
                processed: true,
                timestamp: new Date().toISOString(),
                result: `Processed: ${message}`
            }
        };

        log.info('[ChildAgent] Completing synchronously', { result: result.data.result });

        ctx.complete();

        return result;
    }
}, import.meta.url);
