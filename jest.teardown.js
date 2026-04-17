// Global teardown runs ONCE after ALL tests complete
// This is different from afterAll in jest.setup.js which runs per test suite

export default async function globalTeardown() {
    console.log('[GlobalTeardown] Starting global cleanup...');
    
    // Stop outboxPublisher if it's running
    // Use .js extension - Jest's moduleNameMapper should handle the mapping
    try {
        const outboxModule = await import('./packages/core/src/eventbus/outboxPublisher.js');
        const { outboxPublisher } = outboxModule;
        if (outboxPublisher) {
            console.log('[GlobalTeardown] Stopping outboxPublisher...');
            outboxPublisher.stop();
            if (typeof outboxPublisher.disconnect === 'function') {
                console.log('[GlobalTeardown] Disconnecting outboxPublisher Prisma client...');
                await outboxPublisher.disconnect();
            }
            console.log('[GlobalTeardown] outboxPublisher stopped');
        }
    } catch (error) {
        // Ignore import errors - modules might not be available or already torn down
        if (error instanceof Error && !error.message.includes('Cannot find module')) {
            console.error('[GlobalTeardown] Error stopping outboxPublisher:', error);
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
    
    // Clean up event bus listeners
    try {
        const eventBusModule = await import('./packages/core/src/eventbus/inMemoryEventBus.js');
        const { eventBus } = eventBusModule;
        if (eventBus) {
            const listenerCount = eventBus.listenerCount?.() ?? 0;
            if (listenerCount > 0) {
                console.log(`[GlobalTeardown] Removing ${listenerCount} event listeners...`);
                eventBus.removeAllListeners?.();
            }
        }
    } catch (error) {
        if (error instanceof Error && !error.message.includes('Cannot find module')) {
            console.error('[GlobalTeardown] Error cleaning up eventBus:', error);
        }
    }

    console.log('[GlobalTeardown] Cleanup complete');
}

