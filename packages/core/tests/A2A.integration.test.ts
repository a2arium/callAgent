import { createTestContext } from '../test-utils.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import { createAgent } from '../src/index.js';
import { globalA2AService } from '../src/core/orchestration/A2AService.js';

describe('A2A Integration Tests', () => {
    beforeAll(() => {
        // Register test agents
        const childAgent = createAgent({
            manifest: { name: 'test-child-agent', version: '1.0.0' },
            async handleTask(ctx) {
                await ctx.setGoal?.('Child agent goal');
                await ctx.addThought?.('Processing parent request');
                return { success: true, data: 'child-result' };
            }
        }, import.meta.url);

        const parentAgent = createAgent({
            manifest: { name: 'test-parent-agent', version: '1.0.0' },
            async handleTask(ctx) {
                await ctx.setGoal?.('Parent agent goal');

                const result = await ctx.sendTaskToAgent?.('test-child-agent', {
                    message: 'Hello from parent'
                }, {
                    inheritWorkingMemory: true,
                    inheritMemory: false
                });

                return { parentResult: result };
            }
        }, import.meta.url);

        PluginManager.registerAgent(childAgent);
        PluginManager.registerAgent(parentAgent);
    });

    test('should successfully call child agent from parent', async () => {
        const ctx = await createTestContext('test-tenant', {}, 'test-parent-agent');

        const result = await ctx.sendTaskToAgent?.('test-child-agent', {
            message: 'Hello from test'
        });

        expect(result).toEqual({ success: true, data: 'child-result' });
    });

    test('should transfer working memory context', async () => {
        const ctx = await createTestContext('test-tenant', {}, 'test-parent-agent');

        // Set up parent context
        await ctx.setGoal?.('Test goal transfer');
        await ctx.addThought?.('Test thought transfer');
        ctx.vars!.testVar = 'test-value';

        // Create child that checks inherited context
        const childAgent = createAgent({
            manifest: { name: 'context-check-child', version: '1.0.0' },
            async handleTask(ctx) {
                const goal = await ctx.getGoal?.();
                const thoughts = await ctx.getThoughts?.() || [];
                const testVar = ctx.vars?.testVar;

                return {
                    inheritedGoal: goal,
                    thoughtCount: thoughts.length,
                    inheritedVar: testVar
                };
            }
        }, import.meta.url);

        PluginManager.registerAgent(childAgent);

        const result = await ctx.sendTaskToAgent?.('context-check-child', {}, {
            inheritWorkingMemory: true
        }) as any;

        expect(result.inheritedGoal).toBe('Test goal transfer');
        expect(result.thoughtCount).toBeGreaterThan(0);
        expect(result.inheritedVar).toBe('test-value');
    });

    test('should maintain tenant isolation', async () => {
        const ctx1 = await createTestContext('tenant-1', {}, 'test-agent');
        const ctx2 = await createTestContext('tenant-2', {}, 'test-agent');

        await ctx1.setGoal?.('Tenant 1 goal');
        await ctx2.setGoal?.('Tenant 2 goal');

        // Child should only see the calling tenant's context
        const isolationChild = createAgent({
            manifest: { name: 'isolation-child', version: '1.0.0' },
            async handleTask(ctx) {
                return {
                    tenantId: ctx.tenantId,
                    goal: await ctx.getGoal?.()
                };
            }
        }, import.meta.url);

        PluginManager.registerAgent(isolationChild);

        const result1 = await ctx1.sendTaskToAgent?.('isolation-child', {}, {
            inheritWorkingMemory: true
        }) as any;

        const result2 = await ctx2.sendTaskToAgent?.('isolation-child', {}, {
            inheritWorkingMemory: true
        }) as any;

        expect(result1.tenantId).toBe('tenant-1');
        expect(result1.goal).toBe('Tenant 1 goal');
        expect(result2.tenantId).toBe('tenant-2');
        expect(result2.goal).toBe('Tenant 2 goal');
    });

    test('should handle agent not found error', async () => {
        const ctx = await createTestContext('test-tenant', {}, 'test-agent');

        await expect(ctx.sendTaskToAgent?.('nonexistent-agent', {}))
            .rejects.toThrow("Agent 'nonexistent-agent' not found");
    });

    test('should handle task execution errors gracefully', async () => {
        const errorAgent = createAgent({
            manifest: { name: 'error-agent', version: '1.0.0' },
            async handleTask(ctx) {
                throw new Error('Test error from child agent');
            }
        }, import.meta.url);

        PluginManager.registerAgent(errorAgent);

        const ctx = await createTestContext('test-tenant', {}, 'test-agent');

        await expect(ctx.sendTaskToAgent?.('error-agent', {}))
            .rejects.toThrow('Test error from child agent');
    });

    test('should support streaming option', async () => {
        const streamingChild = createAgent({
            manifest: { name: 'streaming-child', version: '1.0.0' },
            async handleTask(ctx) {
                return { streaming: true, data: 'streaming-result' };
            }
        }, import.meta.url);

        PluginManager.registerAgent(streamingChild);

        const ctx = await createTestContext('test-tenant', {}, 'test-agent');

        const result = await ctx.sendTaskToAgent?.('streaming-child', {}, {
            streaming: true
        });

        // When streaming is true, we should get an InteractiveTaskHandler
        expect(result).toBeDefined();
        // For now, the implementation returns the direct result, but this tests the option is accepted
    });

    test('should preserve memory context without inheritance', async () => {
        const ctx = await createTestContext('test-tenant', {}, 'test-agent');

        // Set up some context that should NOT be inherited
        await ctx.setGoal?.('Parent goal');
        await ctx.addThought?.('Parent thought');

        const isolatedChild = createAgent({
            manifest: { name: 'isolated-child', version: '1.0.0' },
            async handleTask(ctx) {
                const goal = await ctx.getGoal?.();
                const thoughts = await ctx.getThoughts?.() || [];

                return {
                    hasGoal: !!goal,
                    thoughtCount: thoughts.length,
                    tenantId: ctx.tenantId // Should still have correct tenant
                };
            }
        }, import.meta.url);

        PluginManager.registerAgent(isolatedChild);

        const result = await ctx.sendTaskToAgent?.('isolated-child', {}, {
            inheritWorkingMemory: false
        }) as any;

        expect(result.tenantId).toBe('test-tenant'); // Tenant should be preserved
        expect(result.hasGoal).toBe(false); // Goal should not be inherited
        expect(result.thoughtCount).toBe(0); // Thoughts should not be inherited
    });

    test('should handle complex nested agent calls', async () => {
        // Create a simpler chain: parent -> child
        const simpleChildAgent = createAgent({
            manifest: { name: 'simple-child-agent', version: '1.0.0' },
            async handleTask(ctx) {
                return { level: 'child', tenantId: ctx.tenantId };
            }
        }, import.meta.url);

        const simpleParentAgent = createAgent({
            manifest: { name: 'simple-parent-agent', version: '1.0.0' },
            async handleTask(ctx) {
                // Check if sendTaskToAgent is available
                if (!ctx.sendTaskToAgent) {
                    return { level: 'parent', tenantId: ctx.tenantId, error: 'sendTaskToAgent not available' };
                }

                const childResult = await ctx.sendTaskToAgent('simple-child-agent', {});
                return {
                    level: 'parent',
                    tenantId: ctx.tenantId,
                    childResult
                };
            }
        }, import.meta.url);

        PluginManager.registerAgent(simpleChildAgent);
        PluginManager.registerAgent(simpleParentAgent);

        const ctx = await createTestContext('nested-tenant', {}, 'test-agent');

        const result = await ctx.sendTaskToAgent?.('simple-parent-agent', {}) as any;

        expect(result.level).toBe('parent');
        expect(result.tenantId).toBe('nested-tenant');
        expect(result.childResult).toBeDefined();
        expect(result.childResult.level).toBe('child');
        expect(result.childResult.tenantId).toBe('nested-tenant');
    });
}); 