// Disable outboxPublisher auto-start in tests to prevent background services
// Tests should explicitly start/stop services they need
process.env.DISABLE_OUTBOX_PUBLISHER = '1';

// Avoid async Opik flush after Jest has finished (spurious "Cannot log after tests are done")
if (process.env.CALLAGENT_OPIK_ENABLED === undefined) {
    process.env.CALLAGENT_OPIK_ENABLED = '0';
}

// Per-test-suite teardown (runs after each test file)
// Note: Global teardown in jest.teardown.js runs ONCE after ALL tests
// Use dynamic import for ESM modules in CommonJS context
const setupTeardown = async () => {
    const { afterAll } = await import('@jest/globals');
    
    afterAll(async () => {
        // Log event loop state for debugging
        const handles = process._getActiveHandles ? process._getActiveHandles().length : 'unknown';
        const requests = process._getActiveRequests ? process._getActiveRequests().length : 'unknown';
        console.log(`[SuiteTeardown] Active handles: ${handles}, Active requests: ${requests}`);
        
        // Stop outboxPublisher if it's running (per-suite cleanup)
        try {
            const { outboxPublisher } = await import('./packages/core/src/eventbus/outboxPublisher.js');
            if (outboxPublisher && typeof outboxPublisher.stop === 'function') {
                outboxPublisher.stop();
            }
        } catch (error) {
            // Ignore - global teardown will handle it
        }
    });
};

// Execute setup synchronously - Jest will wait for the promise
setupTeardown().catch(() => {
    // Ignore errors during setup
});

