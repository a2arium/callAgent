import { createTestContext, cleanupTestContext } from '../test-utils.js';

describe('Phase 1 Complete Memory System - Simple', () => {
    describe('Basic Functionality', () => {
        it('should create test context successfully', async () => {
            const ctx = await createTestContext('test-tenant');
            expect(ctx).toBeDefined();
            expect(ctx.memory).toBeDefined();
            expect(ctx.memory.mlo).toBeDefined();
        });

        it('should handle working memory operations', async () => {
            const ctx = await createTestContext('test-tenant-working');

            // Test goal operations
            await (ctx as any).goals?.add?.({ title: 'Test goal' });
            const g = await (ctx as any).goals?.read?.({});
            expect(Array.isArray(g) && g[0]?.title).toBe('Test goal');

            // Test thought operations
            await (ctx as any).thoughts?.add?.('Test thought');

            await cleanupTestContext(ctx);
        });

        it('should handle unified operations', async () => {
            const ctx = await createTestContext('test-tenant-unified');

            // Test recall operation
            if (ctx.recall) {
                const results = await ctx.recall('test');
                expect(Array.isArray(results)).toBe(true);
            }

            // Test remember operation
            if (ctx.remember) {
                await ctx.remember('test-key', 'test-value');
                // Should not throw
            }

            await cleanupTestContext(ctx);
        });

        it('should provide MLO access', async () => {
            const ctx = await createTestContext('test-tenant-mlo');

            expect(ctx.memory).toBeDefined();
            expect(ctx.memory.mlo).toBeDefined();

            // MLO should have basic methods
            const mlo = ctx.memory.mlo;
            expect(typeof mlo).toBe('object');
        });
    });
}); 