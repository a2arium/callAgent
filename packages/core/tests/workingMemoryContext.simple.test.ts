import { extendContextWithMemory } from '../src/core/context/workingMemoryContext.js';

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

    it('should create context with memory capabilities', () => {
        const agentConfig = {
            memory: {
                profile: 'basic'
            }
        };

        const context = extendContextWithMemory(
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
    });

    it('should handle basic goal operations', async () => {
        const agentConfig = { memory: { profile: 'basic' } };
        const context = extendContextWithMemory(baseContext, tenantId, agentId, agentConfig);

        const goal = 'Test goal';
        await context.setGoal?.(goal);
        const retrievedGoal = await context.getGoal?.();

        expect(retrievedGoal).toBe(goal);

        // Cleanup
        await (context.memory.mlo as any).shutdown();
    });

    it('should handle configuration resolution', () => {
        // Test with no config
        const context1 = extendContextWithMemory(baseContext, tenantId, agentId, {});
        expect((context1.memory.mlo as any).getConfiguration().profile).toBe('basic');

        // Test with specific profile
        const context2 = extendContextWithMemory(
            baseContext,
            tenantId,
            agentId,
            { memory: { profile: 'conversational' } }
        );
        expect((context2.memory.mlo as any).getConfiguration().profile).toBe('conversational');

        // Cleanup
        (context1.memory.mlo as any).shutdown();
        (context2.memory.mlo as any).shutdown();
    });
}); 