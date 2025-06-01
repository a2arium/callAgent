import { WorkingMemoryStore } from '../src/core/memory/stores/WorkingMemoryStore.js';

describe('WorkingMemoryStore', () => {
    let store: WorkingMemoryStore;

    beforeEach(() => {
        store = new WorkingMemoryStore();
    });

    describe('Goal Operations', () => {
        it('should store and retrieve goals for different sessions', async () => {
            // Set goals for different tenant/agent combinations
            await store.storeGoal({ content: 'Goal 1', timestamp: new Date().toISOString() }, 'tenant1', 'agent1');
            await store.storeGoal({ content: 'Goal 2', timestamp: new Date().toISOString() }, 'tenant2', 'agent1');

            // Verify goals are stored separately
            expect(await store.getGoal('tenant1', 'agent1')).toBe('Goal 1');
            expect(await store.getGoal('tenant2', 'agent1')).toBe('Goal 2');
        });

        it('should maintain goal isolation between tenants', async () => {
            // Set different goals for same agent ID but different tenants
            await store.storeGoal({ content: 'Tenant1 Goal', timestamp: new Date().toISOString() }, 'tenant1', 'agent1');
            await store.storeGoal({ content: 'Tenant2 Goal', timestamp: new Date().toISOString() }, 'tenant2', 'agent1');

            // Verify isolation
            expect(await store.getGoal('tenant1', 'agent1')).toBe('Tenant1 Goal');
            expect(await store.getGoal('tenant2', 'agent1')).toBe('Tenant2 Goal');
        });

        it('should maintain goal isolation between agents', async () => {
            // Set different goals for same tenant but different agents
            await store.storeGoal({ content: 'Agent1 Goal', timestamp: new Date().toISOString() }, 'tenant1', 'agent1');
            await store.storeGoal({ content: 'Agent2 Goal', timestamp: new Date().toISOString() }, 'tenant1', 'agent2');

            // Verify isolation
            expect(await store.getGoal('tenant1', 'agent1')).toBe('Agent1 Goal');
            expect(await store.getGoal('tenant1', 'agent2')).toBe('Agent2 Goal');
        });

        it('should return null for non-existent sessions', async () => {
            const goal = await store.getGoal('nonexistent-tenant', 'nonexistent-agent');
            expect(goal).toBeNull();
        });
    });

    describe('Thought Operations', () => {
        it('should store and retrieve thoughts for different sessions', async () => {
            // Add thoughts to different sessions
            await store.addThought({ content: 'Thought 1', timestamp: new Date().toISOString(), type: 'thought' }, 'tenant1', 'agent1');
            await store.addThought({ content: 'Thought 2', timestamp: new Date().toISOString(), type: 'thought' }, 'tenant2', 'agent1');

            // Verify thoughts are stored separately
            const thoughts1 = await store.getThoughts('tenant1', 'agent1');
            const thoughts2 = await store.getThoughts('tenant2', 'agent1');

            expect(thoughts1).toHaveLength(1);
            expect(thoughts1[0].content).toBe('Thought 1');
            expect(thoughts2).toHaveLength(1);
            expect(thoughts2[0].content).toBe('Thought 2');
        });

        it('should maintain thought isolation between sessions', async () => {
            // Add multiple thoughts to different sessions
            await store.addThought({ content: 'T1 Thought 1', timestamp: new Date().toISOString(), type: 'thought' }, 'tenant1', 'agent1');
            await store.addThought({ content: 'T1 Thought 2', timestamp: new Date().toISOString(), type: 'thought' }, 'tenant1', 'agent1');
            await store.addThought({ content: 'T2 Thought 1', timestamp: new Date().toISOString(), type: 'thought' }, 'tenant2', 'agent1');

            const thoughts1 = await store.getThoughts('tenant1', 'agent1');
            const thoughts2 = await store.getThoughts('tenant2', 'agent1');

            expect(thoughts1).toHaveLength(2);
            expect(thoughts2).toHaveLength(1);
            expect(thoughts1.map(t => t.content)).toEqual(['T1 Thought 1', 'T1 Thought 2']);
            expect(thoughts2[0].content).toBe('T2 Thought 1');
        });
    });

    describe('Decision Operations', () => {
        it('should store and retrieve decisions for different sessions', async () => {
            // Make decisions in different sessions
            await store.makeDecision('approach', 'decision1', 'reasoning1', 'tenant1', 'agent1');
            await store.makeDecision('approach', 'decision2', 'reasoning2', 'tenant2', 'agent1');

            // Verify decisions are stored separately
            const decision1 = await store.getDecision('approach', 'tenant1', 'agent1');
            const decision2 = await store.getDecision('approach', 'tenant2', 'agent1');

            expect(decision1?.decision).toBe('decision1');
            expect(decision1?.reasoning).toBe('reasoning1');
            expect(decision2?.decision).toBe('decision2');
            expect(decision2?.reasoning).toBe('reasoning2');
        });

        it('should maintain decision isolation between sessions', async () => {
            // Make different decisions with same key in different sessions
            await store.makeDecision('strategy', 'strategy1', undefined, 'tenant1', 'agent1');
            await store.makeDecision('strategy', 'strategy2', undefined, 'tenant1', 'agent2');

            const decision1 = await store.getDecision('strategy', 'tenant1', 'agent1');
            const decision2 = await store.getDecision('strategy', 'tenant1', 'agent2');

            expect(decision1?.decision).toBe('strategy1');
            expect(decision2?.decision).toBe('strategy2');
        });

        it('should return null for non-existent decisions', async () => {
            const decision = await store.getDecision('nonexistent', 'tenant1', 'agent1');
            expect(decision).toBeNull();
        });
    });

    describe('Variable Operations', () => {
        it('should store and retrieve variables for different sessions', async () => {
            // Set variables in different sessions
            await store.setVariable('testVar', 'value1', 'tenant1', 'agent1');
            await store.setVariable('testVar', 'value2', 'tenant2', 'agent1');

            // Verify variables are stored separately
            expect(await store.getVariable('testVar', 'tenant1', 'agent1')).toBe('value1');
            expect(await store.getVariable('testVar', 'tenant2', 'agent1')).toBe('value2');
        });

        it('should handle complex variable types', async () => {
            const complexValue = { nested: { data: [1, 2, 3] }, boolean: true };
            await store.setVariable('complex', complexValue, 'tenant1', 'agent1');

            const retrieved = await store.getVariable('complex', 'tenant1', 'agent1');
            expect(retrieved).toEqual(complexValue);
        });

        it('should maintain variable isolation between sessions', async () => {
            // Set same variable name with different values in different sessions
            await store.setVariable('sharedVar', 'tenant1_value', 'tenant1', 'agent1');
            await store.setVariable('sharedVar', 'tenant2_value', 'tenant2', 'agent1');
            await store.setVariable('sharedVar', 'agent2_value', 'tenant1', 'agent2');

            expect(await store.getVariable('sharedVar', 'tenant1', 'agent1')).toBe('tenant1_value');
            expect(await store.getVariable('sharedVar', 'tenant2', 'agent1')).toBe('tenant2_value');
            expect(await store.getVariable('sharedVar', 'tenant1', 'agent2')).toBe('agent2_value');
        });

        it('should return undefined for non-existent variables', async () => {
            const value = await store.getVariable('nonexistent', 'tenant1', 'agent1');
            expect(value).toBeUndefined();
        });
    });

    describe('Session Management', () => {
        it('should clear sessions correctly', async () => {
            // Set up some data
            await store.storeGoal({ content: 'Test goal', timestamp: new Date().toISOString() }, 'tenant1', 'agent1');
            await store.setVariable('testVar', 'testValue', 'tenant1', 'agent1');

            // Verify data exists
            expect(await store.getGoal('tenant1', 'agent1')).toBe('Test goal');
            expect(await store.getVariable('testVar', 'tenant1', 'agent1')).toBe('testValue');

            // Clear session
            store.clearSession('tenant1', 'agent1');

            // Verify data is cleared (new session created)
            expect(await store.getGoal('tenant1', 'agent1')).toBeNull();
            expect(await store.getVariable('testVar', 'tenant1', 'agent1')).toBeUndefined();
        });

        it('should not affect other sessions when clearing', async () => {
            // Set up data in multiple sessions
            await store.storeGoal({ content: 'Goal 1', timestamp: new Date().toISOString() }, 'tenant1', 'agent1');
            await store.storeGoal({ content: 'Goal 2', timestamp: new Date().toISOString() }, 'tenant1', 'agent2');

            // Clear one session
            store.clearSession('tenant1', 'agent1');

            // Verify only the cleared session is affected
            expect(await store.getGoal('tenant1', 'agent1')).toBeNull();
            expect(await store.getGoal('tenant1', 'agent2')).toBe('Goal 2');
        });
    });

    describe('Multi-Tenant Scenarios', () => {
        it('should handle concurrent operations across sessions', async () => {
            // Perform concurrent operations
            await Promise.all([
                store.storeGoal({ content: 'Concurrent goal 1', timestamp: new Date().toISOString() }, 'tenant1', 'agent1'),
                store.storeGoal({ content: 'Concurrent goal 2', timestamp: new Date().toISOString() }, 'tenant2', 'agent2'),
                store.setVariable('concurrentVar', 'value1', 'tenant1', 'agent1'),
                store.setVariable('concurrentVar', 'value2', 'tenant2', 'agent2'),
            ]);

            // Verify results
            expect(await store.getGoal('tenant1', 'agent1')).toBe('Concurrent goal 1');
            expect(await store.getGoal('tenant2', 'agent2')).toBe('Concurrent goal 2');
            expect(await store.getVariable('concurrentVar', 'tenant1', 'agent1')).toBe('value1');
            expect(await store.getVariable('concurrentVar', 'tenant2', 'agent2')).toBe('value2');
        });

        it('should handle edge cases with special characters', async () => {
            const specialTenant = 'tenant-with-dashes_and_underscores';
            const specialAgent = 'agent.with.dots';

            await store.storeGoal({ content: 'Special goal', timestamp: new Date().toISOString() }, specialTenant, specialAgent);
            expect(await store.getGoal(specialTenant, specialAgent)).toBe('Special goal');
        });

        it('should handle empty string IDs', async () => {
            await store.storeGoal({ content: 'Empty ID goal', timestamp: new Date().toISOString() }, '', '');
            expect(await store.getGoal('', '')).toBe('Empty ID goal');
        });
    });

    describe('Integration Tests', () => {
        it('should support complex workflow across all operations', async () => {
            const tenantId = 'integration-tenant';
            const agentId = 'integration-agent';

            // Set goal
            await store.storeGoal({ content: 'Integration test goal', timestamp: new Date().toISOString() }, tenantId, agentId);

            // Add thoughts
            await store.addThought({ content: 'First thought', timestamp: new Date().toISOString(), type: 'thought' }, tenantId, agentId);
            await store.addThought({ content: 'Second thought', timestamp: new Date().toISOString(), type: 'thought' }, tenantId, agentId);

            // Make decisions
            await store.makeDecision('approach', 'use_llm', 'Best for complex tasks', tenantId, agentId);
            await store.makeDecision('strategy', 'research_first', undefined, tenantId, agentId);

            // Set variables
            await store.setVariable('userRequest', 'implement auth', tenantId, agentId);
            await store.setVariable('complexity', 'medium', tenantId, agentId);

            // Verify all operations
            expect(await store.getGoal(tenantId, agentId)).toBe('Integration test goal');

            const thoughts = await store.getThoughts(tenantId, agentId);
            expect(thoughts).toHaveLength(2);
            expect(thoughts.map(t => t.content)).toEqual(['First thought', 'Second thought']);

            const approachDecision = await store.getDecision('approach', tenantId, agentId);
            const strategyDecision = await store.getDecision('strategy', tenantId, agentId);
            expect(approachDecision?.decision).toBe('use_llm');
            expect(approachDecision?.reasoning).toBe('Best for complex tasks');
            expect(strategyDecision?.decision).toBe('research_first');
            expect(strategyDecision?.reasoning).toBeUndefined();

            expect(await store.getVariable('userRequest', tenantId, agentId)).toBe('implement auth');
            expect(await store.getVariable('complexity', tenantId, agentId)).toBe('medium');
        });
    });
}); 