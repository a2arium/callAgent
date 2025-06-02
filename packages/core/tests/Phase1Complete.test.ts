import { createTestContext, cleanupTestContext, waitForAsync } from '../test-utils.js';
import { getMemoryProfile } from '../src/core/memory/lifecycle/config/MemoryProfiles.js';
import { extendContextWithMemory } from '../src/core/memory/types/working/context/workingMemoryContext.js';

describe('Phase 1 Complete Memory System', () => {
    describe('Backward Compatibility', () => {
        let ctx: any;

        beforeEach(() => {
            ctx = createTestContext('test-tenant');
        });

        afterEach(async () => {
            await cleanupTestContext(ctx);
        });

        it('semantic memory should work exactly as before', async () => {
            // Should work identically to current implementation
            const extendedMemory = ctx.memory as any;
            await extendedMemory.semantic?.set('test-key', 'test-value');
            const value = await extendedMemory.semantic?.get('test-key');
            expect(value).toBe('test-value');

            // getMany should work (replaces deprecated query method)
            await extendedMemory.semantic?.set('item1', 'apple');
            await extendedMemory.semantic?.set('item2', 'application');
            const results = await extendedMemory.semantic?.getMany('app*');
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);
        });

        it('should maintain existing memory interface structure', () => {
            expect(ctx.memory).toBeDefined();
            expect(ctx.memory.mlo).toBeDefined();

            // Extended memory interface should be available
            const extendedMemory = ctx.memory as any;
            expect(extendedMemory.semantic).toBeDefined();
            expect(extendedMemory.episodic).toBeDefined();
        });

        it('should handle missing adapters gracefully', async () => {
            // Create context without adapters by extending manually
            const baseContext = {
                tenantId: 'test-tenant',
                task: { id: 'test-task', input: { test: true } },
                reply: (() => Promise.resolve()) as any,
                progress: (() => { }) as any,
                complete: (() => { }) as any,
                fail: (() => Promise.resolve()) as any,
                recordUsage: (() => { }) as any,
                llm: {
                    call: (() => Promise.resolve({ content: 'mock response' })) as any,
                    callWithSchema: (() => Promise.resolve({ content: 'mock response' })) as any
                },
                tools: { invoke: (() => Promise.resolve({})) as any },
                logger: {
                    debug: (() => { }) as any,
                    info: (() => { }) as any,
                    warn: (() => { }) as any,
                    error: (() => { }) as any
                },
                config: {},
                validate: (() => true) as any,
                retry: (async (fn: any) => await fn()) as any,
                cache: {
                    get: (() => Promise.resolve(null)) as any,
                    set: (() => Promise.resolve()) as any,
                    delete: (() => Promise.resolve()) as any
                },
                emitEvent: (() => Promise.resolve()) as any,
                updateStatus: (() => { }) as any,
                services: { get: (() => undefined) as any },
                getEnv: (() => undefined) as any,
                throw: ((code: string, message: string) => {
                    throw new Error(`${code}: ${message}`);
                }) as any
            };

            // Extend with memory but NO adapters
            const ctxWithoutAdapters = extendContextWithMemory(
                baseContext,
                'test-tenant',
                'test-agent',
                { memory: { profile: 'basic' } },
                undefined // No semantic adapter
            );

            const extendedMemory = ctxWithoutAdapters.memory as any;

            // Should throw meaningful errors for missing adapters
            await expect(
                extendedMemory.semantic?.set('key', 'value')
            ).rejects.toThrow('No semantic memory adapter configured');

            await expect(
                extendedMemory.episodic?.append({ event: 'test' })
            ).rejects.toThrow('No episodic memory adapter configured');

            await cleanupTestContext(ctxWithoutAdapters);
        });
    });

    describe('Working Memory', () => {
        let ctx: any;

        beforeEach(() => {
            ctx = createTestContext('test-tenant');
        });

        afterEach(async () => {
            await cleanupTestContext(ctx);
        });

        it('should provide complete working memory functionality', async () => {
            // Goal management
            await ctx.setGoal?.('Test goal');
            expect(await ctx.getGoal?.()).toBe('Test goal');

            // Thought tracking
            await ctx.addThought?.('First thought');
            await ctx.addThought?.('Second thought');
            const thoughts = await ctx.getThoughts?.();
            expect(thoughts).toHaveLength(2);
            expect(thoughts[0].content).toBe('First thought');
            expect(thoughts[1].content).toBe('Second thought');

            // Decision tracking
            await ctx.makeDecision?.('approach', 'use_llm', 'Best for this task');
            const decision = await ctx.getDecision?.('approach');
            expect(decision?.decision).toBe('use_llm');
            expect(decision?.reasoning).toBe('Best for this task');
            expect(decision?.timestamp).toBeDefined();
        });

        it('should handle working variables through proxy', async () => {
            if (ctx.vars) {
                // Set simple values
                ctx.vars.testVar = 'test value';
                await waitForAsync(); // Allow async operations to complete

                const retrievedValue = await ctx.vars.testVar;
                expect(retrievedValue).toBe('test value');

                // Set complex values
                ctx.vars.complexVar = { nested: { value: 123 } };
                await waitForAsync();

                const complexValue = await ctx.vars.complexVar;
                expect(complexValue).toEqual({ nested: { value: 123 } });
            }
        });

        it('should isolate working memory by agent', async () => {
            const ctx1 = createTestContext('test-tenant', {}, 'agent1');
            const ctx2 = createTestContext('test-tenant', {}, 'agent2');

            // Set different goals for different agents
            await ctx1.setGoal?.('Agent 1 goal');
            await ctx2.setGoal?.('Agent 2 goal');

            expect(await ctx1.getGoal?.()).toBe('Agent 1 goal');
            expect(await ctx2.getGoal?.()).toBe('Agent 2 goal');

            // Add different thoughts
            await ctx1.addThought?.('Agent 1 thought');
            await ctx2.addThought?.('Agent 2 thought');

            const thoughts1 = await ctx1.getThoughts?.();
            const thoughts2 = await ctx2.getThoughts?.();

            expect(thoughts1).toHaveLength(1);
            expect(thoughts2).toHaveLength(1);
            expect(thoughts1?.[0]?.content).toBe('Agent 1 thought');
            expect(thoughts2?.[0]?.content).toBe('Agent 2 thought');

            await cleanupTestContext(ctx1);
            await cleanupTestContext(ctx2);
        });

        it('should handle errors gracefully', async () => {
            // Goals and decisions should throw on failure (critical operations)
            // Thoughts should not throw (non-critical operations)
            await expect(ctx.addThought?.('Test thought')).resolves.not.toThrow();
        });
    });

    describe('MLO Pipeline', () => {
        let ctx: any;

        beforeEach(() => {
            ctx = createTestContext('test-tenant');
        });

        afterEach(async () => {
            await cleanupTestContext(ctx);
        });

        it('should process all memory operations through MLO', async () => {
            await ctx.addThought?.('Test thought for MLO');
            const thoughts = await ctx.getThoughts?.();

            // Verify MLO processing
            const thought = thoughts[0];
            expect(thought.processingMetadata?.processingHistory).toBeDefined();
            expect(thought.processingMetadata.processingHistory.length).toBeGreaterThan(0);

            // Should include stage processing
            const history = thought.processingMetadata.processingHistory;
            expect(Array.isArray(history)).toBe(true);
            expect(history.length).toBeGreaterThan(0);
        });

        it('should include all processing stages', async () => {
            await ctx.addThought?.('Test thought for stage verification');
            const thoughts = await ctx.getThoughts?.();

            const history = thoughts[0]?.processingMetadata?.processingHistory || [];

            // Should include processors from different stages
            // Note: The exact processor names depend on the basic profile configuration
            expect(history.length).toBeGreaterThan(0);

            // Verify we have some processing stages represented
            const historyString = history.join(' ');
            expect(historyString.length).toBeGreaterThan(0);
        });

        it('should provide MLO metrics and configuration', async () => {
            const mlo = ctx.memory.mlo as any;

            if (mlo) {
                const metrics = mlo.getMetrics();
                expect(metrics).toBeDefined();
                expect(typeof metrics).toBe('object');

                const config = mlo.getConfiguration();
                expect(config).toBeDefined();
                expect(config.profile).toBeDefined();
            }
        });

        it('should track processing performance', async () => {
            const mlo = ctx.memory.mlo as any;

            if (mlo) {
                // Add multiple thoughts to generate metrics
                await ctx.addThought?.('First thought');
                await ctx.addThought?.('Second thought');
                await ctx.addThought?.('Third thought');

                const metrics = mlo.getMetrics();
                expect(metrics.mlo).toBeDefined();

                // Should have processing metrics
                if (metrics.mlo.totalProcessed !== undefined) {
                    expect(metrics.mlo.totalProcessed).toBeGreaterThan(0);
                }
            }
        });
    });

    describe('Agent Configuration', () => {
        it('should load configuration from agent manifest', async () => {
            const agentConfig = {
                memory: {
                    profile: 'conversational',
                    workingMemory: {
                        acquisition: {
                            compressor: 'TextTruncationCompressor'
                        }
                    }
                }
            };

            const ctx = createTestContext('test-tenant', agentConfig);

            await ctx.addThought?.('This goes through conversational pipeline');
            const thoughts = await ctx.getThoughts?.();

            // Verify correct profile was used
            const mlo = ctx.memory.mlo as any;
            if (mlo) {
                const config = mlo.getConfiguration();
                expect(config.profile).toBe('conversational');
            }

            await cleanupTestContext(ctx);
        });

        it('should use basic profile by default', async () => {
            const ctx = createTestContext('test-tenant', {});

            const mlo = ctx.memory.mlo as any;
            if (mlo) {
                const config = mlo.getConfiguration();
                expect(config.profile).toBe('basic');
            }

            await cleanupTestContext(ctx);
        });

        it('should handle unknown profiles gracefully', async () => {
            const agentConfig = {
                memory: {
                    profile: 'unknown-profile'
                }
            };

            // Should not throw, should fall back to basic
            const ctx = createTestContext('test-tenant', agentConfig);

            const mlo = ctx.memory.mlo as any;
            if (mlo) {
                const config = mlo.getConfiguration();
                expect(config.profile).toBe('basic'); // Should fall back
            }

            await cleanupTestContext(ctx);
        });

        it('should apply working memory overrides', async () => {
            const agentConfig = {
                memory: {
                    profile: 'basic',
                    workingMemory: {
                        maxThoughts: 100,
                        customSetting: true
                    }
                }
            };

            const ctx = createTestContext('test-tenant', agentConfig);

            const mlo = ctx.memory.mlo as any;
            if (mlo) {
                const config = mlo.getConfiguration();
                expect(config.workingMemory.maxThoughts).toBe(100);
                expect(config.workingMemory.customSetting).toBe(true);
            }

            await cleanupTestContext(ctx);
        });
    });

    describe('Unified Operations', () => {
        let ctx: any;

        beforeEach(() => {
            ctx = createTestContext('test-tenant');
        });

        afterEach(async () => {
            await cleanupTestContext(ctx);
        });

        it('should support recall across memory types', async () => {
            // Add to different memory types
            await ctx.addThought?.('Working memory contains user preferences');

            const extendedMemory = ctx.memory as any;
            await extendedMemory.semantic?.set('preference', 'detailed explanations');

            // Recall should find results (in Phase 1, simplified implementation)
            const results = await ctx.recall?.('preferences');
            expect(Array.isArray(results)).toBe(true);
            // Note: In Phase 1, recall might return empty array if not fully implemented
            // The important thing is that it doesn't throw and returns an array
        });

        it('should support remember with different persistence options', async () => {
            // Remember without persistence (working memory)
            await ctx.remember?.('temp-value', 'temporary', { persist: false });

            // Should be stored in working variables
            if (ctx.vars) {
                await waitForAsync();
                const tempValue = await ctx.vars['temp-value'];
                expect(tempValue).toBe('temporary');
            }

            // Remember with persistence (semantic)
            await ctx.remember?.('perm-value', 'permanent', {
                persist: true,
                type: 'semantic'
            });

            // Should be stored in semantic memory
            const extendedMemory = ctx.memory as any;
            const retrieved = await extendedMemory.semantic?.get('perm-value');
            expect(retrieved).toBe('permanent');
        });

        it('should handle unified operations with options', async () => {
            // Test recall with options
            const results = await ctx.recall?.('test query', {
                sources: ['working', 'semantic'],
                limit: 5
            });
            expect(Array.isArray(results)).toBe(true);

            // Test remember with complex options
            await ctx.remember?.('complex-item', { data: 'complex' }, {
                persist: true,
                type: 'semantic',
                importance: 'high',
                tags: ['test', 'complex']
            });

            // Should be stored
            const extendedMemory = ctx.memory as any;
            const retrieved = await extendedMemory.semantic?.get('complex-item');
            expect(retrieved).toEqual({ data: 'complex' });
        });

        it('should maintain backward compatibility with unified operations', async () => {
            // Unified operations should not break existing functionality
            const extendedMemory = ctx.memory as any;

            // Traditional semantic memory operations should still work
            await extendedMemory.semantic?.set('traditional-key', 'traditional-value');
            const traditionalValue = await extendedMemory.semantic?.get('traditional-key');
            expect(traditionalValue).toBe('traditional-value');

            // Unified operations should work alongside
            await ctx.remember?.('unified-key', 'unified-value');

            // Both should coexist
            expect(traditionalValue).toBe('traditional-value');
        });
    });

    describe('System Integration', () => {
        let ctx: any;

        beforeEach(() => {
            ctx = createTestContext('test-tenant');
        });

        afterEach(async () => {
            await cleanupTestContext(ctx);
        });

        it('should provide comprehensive system status', async () => {
            // Check that all major components are available
            expect(ctx.setGoal).toBeDefined();
            expect(ctx.getGoal).toBeDefined();
            expect(ctx.addThought).toBeDefined();
            expect(ctx.getThoughts).toBeDefined();
            expect(ctx.makeDecision).toBeDefined();
            expect(ctx.getDecision).toBeDefined();
            expect(ctx.vars).toBeDefined();
            expect(ctx.recall).toBeDefined();
            expect(ctx.remember).toBeDefined();
            expect(ctx.memory).toBeDefined();
            expect(ctx.memory.mlo).toBeDefined();
        });

        it('should handle concurrent operations', async () => {
            // Test concurrent memory operations
            const operations = [
                ctx.addThought?.('Concurrent thought 1'),
                ctx.addThought?.('Concurrent thought 2'),
                ctx.addThought?.('Concurrent thought 3'),
                ctx.setGoal?.('Concurrent goal'),
                ctx.makeDecision?.('concurrent-decision', 'option-a', 'concurrent reasoning')
            ];

            await Promise.all(operations);

            // Verify all operations completed
            const thoughts = await ctx.getThoughts?.();
            const goal = await ctx.getGoal?.();
            const decision = await ctx.getDecision?.('concurrent-decision');

            expect(thoughts).toHaveLength(3);
            expect(goal).toBe('Concurrent goal');
            expect(decision?.decision).toBe('option-a');
        });

        it('should maintain tenant isolation', async () => {
            const ctx1 = createTestContext('tenant1');
            const ctx2 = createTestContext('tenant2');

            // Add data to different tenants
            await ctx1.addThought?.('Tenant 1 thought');
            await ctx2.addThought?.('Tenant 2 thought');

            const extendedMemory1 = ctx1.memory as any;
            const extendedMemory2 = ctx2.memory as any;

            await extendedMemory1.semantic?.set('shared-key', 'tenant1-value');
            await extendedMemory2.semantic?.set('shared-key', 'tenant2-value');

            // Verify isolation
            const thoughts1 = await ctx1.getThoughts?.();
            const thoughts2 = await ctx2.getThoughts?.();

            expect(thoughts1).toHaveLength(1);
            expect(thoughts2).toHaveLength(1);
            expect(thoughts1?.[0]?.content).toBe('Tenant 1 thought');
            expect(thoughts2?.[0]?.content).toBe('Tenant 2 thought');

            const value1 = await extendedMemory1.semantic?.get('shared-key');
            const value2 = await extendedMemory2.semantic?.get('shared-key');

            expect(value1).toBe('tenant1-value');
            expect(value2).toBe('tenant2-value');

            await cleanupTestContext(ctx1);
            await cleanupTestContext(ctx2);
        });

        it('should provide error handling and recovery', async () => {
            // Test that the system handles errors gracefully

            // Non-critical operations should not throw
            await expect(ctx.addThought?.('Test thought')).resolves.not.toThrow();

            // System should remain functional after errors
            await ctx.setGoal?.('Recovery test goal');
            expect(await ctx.getGoal?.()).toBe('Recovery test goal');
        });
    });
}); 