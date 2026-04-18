// Global teardown runs ONCE after ALL tests complete
// This is different from afterAll in jest.setup.js which runs per test suite

export default async function globalTeardown() {
    console.log('[GlobalTeardown] Starting global cleanup...');
    
    try {
        const { EngineLocator } = await import('./packages/core/src/orchestration/EngineLocator.js');
        const engine = EngineLocator.getEngine();
        if (engine?.stopOutboxPublisher) {
            console.log('[GlobalTeardown] Stopping TaskEngine outbox publisher...');
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
            console.log('[GlobalTeardown] Disconnecting memory Prisma client...');
            await disconnectMemoryPrismaClient();
            console.log('[GlobalTeardown] Memory Prisma client disconnected');
        }
    } catch (error) {
        if (error instanceof Error && !error.message.includes('Cannot find module')) {
            console.error('[GlobalTeardown] Error disconnecting Prisma:', error);
        }
    }
    
    console.log('[GlobalTeardown] Cleanup complete');
}

