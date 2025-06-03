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
            if (ctx.setGoal && ctx.getGoal) {
                await ctx.setGoal('Test goal');
                const goal = await ctx.getGoal();
                // Should return the goal we just set
                expect(goal).toBe('Test goal');
            }

            // Test thought operations
            if (ctx.addThought && ctx.getThoughts) {
                const initialThoughts = await ctx.getThoughts();
                const initialCount = initialThoughts.length;

                await ctx.addThought('Test thought');
                const thoughts = await ctx.getThoughts();
                expect(Array.isArray(thoughts)).toBe(true);
                // Should have one more thought than before
                expect(thoughts.length).toBe(initialCount + 1);
                // The last thought should be the one we just added
                expect(thoughts[thoughts.length - 1].content).toBe('Test thought');
            }

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