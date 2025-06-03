import { extendContextWithMemory } from '../src/core/memory/types/working/context/workingMemoryContext.js';

describe('workingMemoryContext - Simple Tests', () => {
    const tenantId = 'test-tenant';
    const agentId = 'test-agent';
    const baseContext = {
        tenantId,
        task: {
            id: 'test-task',
            input: { messages: [] }
        }
    };

    it('should create context with memory capabilities', async () => {
        const agentConfig = {
            memory: {
                profile: 'basic'
            }
        };

        const context = await extendContextWithMemory(
            baseContext,
            tenantId,
            agentId,
            agentConfig
        );

        expect(context.setGoal).toBeDefined();
        expect(context.getGoal).toBeDefined();
        expect(context.addThought).toBeDefined();
        expect(context.getThoughts).toBeDefined();
        expect(context.makeDecision).toBeDefined();
        expect(context.getDecision).toBeDefined();
        expect(context.vars).toBeDefined();
        expect(context.recall).toBeDefined();
        expect(context.remember).toBeDefined();
        expect(context.memory).toBeDefined();
        expect(context.memory.mlo).toBeDefined();

        // Cleanup
        await (context.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
    });

    it('should handle basic goal operations', async () => {
        const agentConfig = { memory: { profile: 'basic' } };
        const context = await extendContextWithMemory(baseContext, tenantId, agentId, agentConfig);

        const goal = 'Test goal';
        await context.setGoal?.(goal);
        const retrievedGoal = await context.getGoal?.();

        // Should return the goal we just set
        expect(retrievedGoal).toBe(goal);

        // Cleanup
        await (context.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
    });

    it('should handle configuration resolution', async () => {
        // Test with no config
        const context1 = await extendContextWithMemory(baseContext, tenantId, agentId, {});
        expect((context1.memory.mlo as unknown as { getConfiguration: () => { profile: string } }).getConfiguration().profile).toBe('basic');

        // Test with specific profile
        const context2 = await extendContextWithMemory(
            baseContext,
            tenantId,
            agentId,
            { memory: { profile: 'conversational' } }
        );
        expect((context2.memory.mlo as unknown as { getConfiguration: () => { profile: string } }).getConfiguration().profile).toBe('conversational');

        // Cleanup
        await (context1.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
        await (context2.memory.mlo as unknown as { shutdown: () => Promise<void> }).shutdown();
    });
}); 