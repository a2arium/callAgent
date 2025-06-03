import { extendContextWithMemory, extendContextWithWorkingMemory, createLegacyWorkingVariablesProxy } from '../src/core/memory/types/working/context/workingMemoryContext.js';
import { TaskContext } from '../src/shared/types/index.js';

describe('workingMemoryContext', () => {
    const tenantId = 'test-tenant';
    const agentId = 'test-agent';
    const baseContext = {
        tenantId,
        task: {
            id: 'test-task',
            input: { messages: [] }
        },
        reply: jest.fn(),
        progress: jest.fn(),
        complete: jest.fn(),
        fail: jest.fn(),
        recordUsage: jest.fn(),
        llm: {} as unknown as Record<string, unknown>,
        tools: { invoke: jest.fn() },
        memory: {},
        cognitive: {
            loadWorkingMemory: jest.fn(),
            plan: jest.fn(),
            record: jest.fn(),
            flush: jest.fn()
        },
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        },
        config: {},
        validate: jest.fn(),
        retry: jest.fn(),
        cache: {
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn()
        },
        emitEvent: jest.fn(),
        updateStatus: jest.fn(),
        services: { get: jest.fn() },
        getEnv: jest.fn(),
        throw: jest.fn()
    };

    describe('extendContextWithMemory', () => {
        let context: TaskContext;

        beforeEach(async () => {
            const agentConfig = {
                memory: {
                    profile: 'basic'
                }
            };

            context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                agentConfig
            );
        });

        afterEach(async () => {
            // Cleanup the UnifiedMemoryService
            if (context.memory?.mlo) {
                await (context.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
            }
        });

        it('should extend context with working memory operations', () => {
            expect(context.setGoal).toBeDefined();
            expect(context.getGoal).toBeDefined();
            expect(context.addThought).toBeDefined();
            expect(context.getThoughts).toBeDefined();
            expect(context.makeDecision).toBeDefined();
            expect(context.getDecision).toBeDefined();
            expect(context.vars).toBeDefined();
            expect(context.recall).toBeDefined();
            expect(context.remember).toBeDefined();
        });

        it('should extend context with enhanced memory interface', () => {
            expect(context.memory).toBeDefined();
            expect(context.memory.mlo).toBeDefined();
            // Note: The semantic/episodic interfaces are part of the extended memory object
            // but may not match the IMemory interface exactly in this implementation
        });

        it('should handle goal operations', async () => {
            const goal = 'Complete the test successfully';

            await context.setGoal!(goal);
            const retrievedGoal = await context.getGoal!();

            expect(retrievedGoal).toBe(goal);
        });

        it('should handle thought operations', async () => {
            const thought1 = 'First test thought';
            const thought2 = 'Second test thought';

            await context.addThought!(thought1);
            await context.addThought!(thought2);

            const thoughts = await context.getThoughts!();
            expect(thoughts).toHaveLength(2);
            expect(thoughts[0].content).toBe(thought1);
            expect(thoughts[1].content).toBe(thought2);
        });

        it('should handle decision operations', async () => {
            const key = 'test_decision';
            const decision = 'Choose option A';
            const reasoning = 'Option A has better performance';

            await context.makeDecision!(key, decision, reasoning);
            const retrievedDecision = await context.getDecision!(key);

            expect(retrievedDecision).not.toBeNull();
            expect(retrievedDecision!.decision).toBe(decision);
            expect(retrievedDecision!.reasoning).toBe(reasoning);
        });

        it('should handle working variables through proxy', async () => {
            const key = 'test_var';
            const value = { status: 'active', count: 42 };

            // Set variable through proxy
            context.vars![key] = value;

            // Give it a moment for the async operation to complete
            await new Promise(resolve => setTimeout(resolve, 10));

            // Get variable through proxy (returns Promise)
            const retrievedValue = await (context.vars![key] as Promise<unknown>);
            expect(retrievedValue).toEqual(value);
        });

        it('should handle unified recall operation', async () => {
            // Add some thoughts first
            await context.addThought!('This is a test thought');
            await context.addThought!('Another thought without the keyword');
            await context.addThought!('Test again in this thought');

            const results = await context.recall!('test');
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);
        });

        it('should handle unified remember operation', async () => {
            const key = 'test_memory';
            const value = 'Important information to remember';

            await context.remember!(key, value);

            // Verify it was stored in working variables
            const retrievedValue = await (context.vars![key] as Promise<unknown>);
            expect(retrievedValue).toBe(value);
        });

        it('should handle semantic memory operations', async () => {
            const key = 'concept';
            const value = 'Machine Learning';

            // Access the extended memory interface
            const extendedMemory = context.memory as unknown as { semantic?: { set: (key: string, value: unknown, namespace: string) => Promise<void>; get: (key: string, namespace: string) => Promise<unknown> } };

            // This will throw since no semantic adapter is configured
            await expect(
                extendedMemory.semantic?.set(key, value, 'ai')
            ).rejects.toThrow('No semantic memory adapter configured');

            await expect(
                extendedMemory.semantic?.get(key, 'ai')
            ).rejects.toThrow('No semantic memory adapter configured');
        });

        it('should handle episodic memory operations', async () => {
            const event = { action: 'test_action', timestamp: Date.now() };

            // Access the extended memory interface
            const extendedMemory = context.memory as unknown as { episodic?: { append: (event: unknown) => Promise<void>; getEvents: () => Promise<unknown[]> } };

            // This will throw since no episodic adapter is configured
            await expect(
                extendedMemory.episodic?.append(event)
            ).rejects.toThrow('No episodic memory adapter configured');

            await expect(
                extendedMemory.episodic?.getEvents()
            ).rejects.toThrow('No episodic memory adapter configured');
        });

        it('should provide direct MLO access', () => {
            expect(context.memory.mlo).toBeDefined();
            expect(typeof (context.memory.mlo as unknown as { getMetrics: () => unknown }).getMetrics).toBe('function');
            expect(typeof (context.memory.mlo as unknown as { getConfiguration: () => unknown }).getConfiguration).toBe('function');
        });
    });

    describe('Configuration Resolution', () => {
        it('should use basic profile by default', async () => {
            const context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                {}
            );

            const mlo = context.memory.mlo as unknown as { getConfiguration: () => { profile: string } };
            expect(mlo.getConfiguration().profile).toBe('basic');
        });

        it('should use specified profile from agent config', async () => {
            const agentConfig = {
                memory: {
                    profile: 'conversational'
                }
            };

            const context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                agentConfig
            );

            const mlo = context.memory.mlo as unknown as { getConfiguration: () => { profile: string } };
            expect(mlo.getConfiguration().profile).toBe('conversational');
        });

        it('should handle unknown profile gracefully', async () => {
            const agentConfig = {
                memory: {
                    profile: 'unknown_profile'
                }
            };

            // Should not throw, should fall back to basic
            const context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                agentConfig
            );

            const mlo = context.memory.mlo as unknown as { getConfiguration: () => { profile: string } };
            expect(mlo.getConfiguration().profile).toBe('basic');
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

            const context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                agentConfig
            );

            const config = (context.memory.mlo as unknown as { getConfiguration: () => { workingMemory: { maxThoughts: number; customSetting: boolean } } }).getConfiguration();
            expect(config.workingMemory.maxThoughts).toBe(100);
            expect(config.workingMemory.customSetting).toBe(true);
        });
    });

    describe('Legacy Functions', () => {
        it('should warn about deprecated extendContextWithWorkingMemory', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            const result = extendContextWithWorkingMemory(baseContext, {});

            expect(consoleSpy).toHaveBeenCalledWith(
                'extendContextWithWorkingMemory is deprecated. Use extendContextWithMemory instead.'
            );
            expect(result.setGoal).toBeDefined();

            consoleSpy.mockRestore();
        });

        it('should throw errors for legacy working memory operations', async () => {
            const result = extendContextWithWorkingMemory(baseContext, {});

            await expect((result as unknown as { setGoal: () => Promise<void> }).setGoal()).rejects.toThrow(
                'Legacy working memory not supported. Use extendContextWithMemory.'
            );
        });

        it('should warn about deprecated createLegacyWorkingVariablesProxy', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            const result = createLegacyWorkingVariablesProxy({});

            expect(consoleSpy).toHaveBeenCalledWith(
                'createWorkingVariablesProxy is deprecated. Use extendContextWithMemory instead.'
            );
            expect(result).toEqual({});

            consoleSpy.mockRestore();
        });
    });

    describe('Error Handling', () => {
        it('should handle MLO processing failures gracefully', async () => {
            const context = await extendContextWithMemory(
                baseContext,
                tenantId,
                agentId,
                { memory: { profile: 'basic' } }
            );

            // Most operations should not throw even if processing fails
            await expect(context.addThought!('test')).resolves.not.toThrow();

            // Cleanup
            await (context.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
        });

        it('should handle missing agent config gracefully', () => {
            expect(() => {
                extendContextWithMemory(baseContext, tenantId, agentId, null);
            }).not.toThrow();
        });
    });
}); 