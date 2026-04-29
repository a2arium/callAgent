// Global teardown runs ONCE after ALL tests complete
// This is different from afterAll in jest.setup.js which runs per test suite

export default async function globalTeardown() {
    const testLogsEnabled = process.env.CALLAGENT_TEST_LOGS === '1';
    if (testLogsEnabled) {
        console.log('[GlobalTeardown] Starting global cleanup...');
    }

    try {
        const { EngineLocator } = await import('./packages/core/src/orchestration/EngineLocator.js');
        const engine = EngineLocator.getEngine();
        if (engine?.stopOutboxPublisher) {
            if (testLogsEnabled) {
                console.log('[GlobalTeardown] Stopping TaskEngine outbox publisher...');
            }
            engine.stopOutboxPublisher();
        }
    } catch (error) {
        if (error instanceof Error && !error.message.includes('Cannot find module')) {
            console.error('[GlobalTeardown] Error stopping outbox via EngineLocator:', error);
        }
    }

    // Disconnect Prisma clients
    try {
        const prismaModule = await import('./packages/core/src/core/memory/prismaSingleton.js');
        const { disconnectMemoryPrismaClient } = prismaModule;
        if (disconnectMemoryPrismaClient) {
            if (testLogsEnabled) {
                console.log('[GlobalTeardown] Disconnecting memory Prisma client...');
            }
            await disconnectMemoryPrismaClient();
            if (testLogsEnabled) {
                console.log('[GlobalTeardown] Memory Prisma client disconnected');
            }
        }
    } catch (error) {
        if (error instanceof Error && !error.message.includes('Cannot find module')) {
            console.error('[GlobalTeardown] Error disconnecting Prisma:', error);
        }
    }

    if (testLogsEnabled) {
        console.log('[GlobalTeardown] Cleanup complete');
    }
}
