import { createTestContext, cleanupTestContext } from '../test-utils.js';

describe('Goals/Thoughts smoke', () => {
    it('goals.read returns array and thoughts.add does not throw', async () => {
        const ctx: any = await createTestContext('test-tenant');
        await ctx.goals.add({ title: 'Test goal', type: 'short', priority: 1 });
        const goals = await ctx.goals.read({});
        expect(Array.isArray(goals)).toBe(true);
        expect(goals.length).toBeGreaterThan(0);
        await expect(ctx.thoughts.add('A sample thought')).resolves.not.toThrow();
        await cleanupTestContext(ctx);
    });
});


