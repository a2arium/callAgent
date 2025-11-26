
import { createAgent } from './packages/core/src/index.js';

export default createAgent({
    manifest: {
        name: 'streaming-cache-test-agent',
        version: '1.0.0',
        cache: {
            enabled: true,
            ttlSeconds: 60,
            excludePaths: ['timestamp']
        }
    },
    async handleTask(ctx) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
            result: 'test-result',
            processedAt: new Date().toISOString(),
            executionTime: 100
        };
    }
}, import.meta.url);
        