import { WorkingMemoryManager } from '../src/core/memory/WorkingMemoryManager.js';

describe('WorkingMemoryManager', () => {
    let wm: WorkingMemoryManager;

    beforeEach(() => {
        wm = new WorkingMemoryManager('test-tenant', 'test-agent');
    });

    describe('Goal Management', () => {
        it('should store and retrieve goal', async () => {
            await wm.setGoal('Test goal');
            const goal = await wm.getGoal();
            expect(goal).toBe('Test goal');
        });

        it('should return null for unset goal', async () => {
            const goal = await wm.getGoal();
            expect(goal).toBeNull();
        });

        it('should overwrite existing goal', async () => {
            await wm.setGoal('First goal');
            await wm.setGoal('Second goal');
            const goal = await wm.getGoal();
            expect(goal).toBe('Second goal');
        });
    });

    describe('Thought Management', () => {
        it('should add and retrieve thoughts', async () => {
            await wm.addThought('First thought');
            await wm.addThought('Second thought');

            const thoughts = await wm.getThoughts();
            expect(thoughts).toHaveLength(2);
            expect(thoughts[0].content).toBe('First thought');
            expect(thoughts[1].content).toBe('Second thought');
        });

        it('should include timestamps in thoughts', async () => {
            const beforeTime = Date.now();
            await wm.addThought('Test thought');
            const afterTime = Date.now();

            const thoughts = await wm.getThoughts();
            expect(thoughts[0].timestamp).toBeDefined();

            const thoughtTime = new Date(thoughts[0].timestamp).getTime();
            expect(thoughtTime).toBeGreaterThanOrEqual(beforeTime);
            expect(thoughtTime).toBeLessThanOrEqual(afterTime);
        });

        it('should set thought type to "thought" by default', async () => {
            await wm.addThought('Test thought');
            const thoughts = await wm.getThoughts();
            expect(thoughts[0].type).toBe('thought');
        });

        it('should maintain thought order', async () => {
            const thoughtContents = ['First', 'Second', 'Third', 'Fourth'];

            for (const content of thoughtContents) {
                await wm.addThought(content);
            }

            const thoughts = await wm.getThoughts();
            expect(thoughts.map(t => t.content)).toEqual(thoughtContents);
        });
    });

    describe('Decision Management', () => {
        it('should make and retrieve decisions', async () => {
            await wm.makeDecision('approach', 'use_llm', 'Best for complex tasks');

            const decision = await wm.getDecision('approach');
            expect(decision).toBeDefined();
            expect(decision?.decision).toBe('use_llm');
            expect(decision?.reasoning).toBe('Best for complex tasks');
        });

        it('should make decisions without reasoning', async () => {
            await wm.makeDecision('strategy', 'research_first');

            const decision = await wm.getDecision('strategy');
            expect(decision).toBeDefined();
            expect(decision?.decision).toBe('research_first');
            expect(decision?.reasoning).toBeUndefined();
        });

        it('should return null for non-existent decisions', async () => {
            const decision = await wm.getDecision('nonexistent');
            expect(decision).toBeNull();
        });

        it('should overwrite existing decisions', async () => {
            await wm.makeDecision('approach', 'first_decision', 'Initial reasoning');
            await wm.makeDecision('approach', 'second_decision', 'Updated reasoning');

            const decision = await wm.getDecision('approach');
            expect(decision?.decision).toBe('second_decision');
            expect(decision?.reasoning).toBe('Updated reasoning');
        });

        it('should add decisions to thought chain', async () => {
            await wm.makeDecision('strategy', 'research_first', 'Need more information');

            const state = wm.serialize();
            const decisionThought = state.thoughtChain.find(t => t.type === 'decision');
            expect(decisionThought).toBeDefined();
            expect(decisionThought?.content).toContain('strategy');
            expect(decisionThought?.content).toContain('research_first');
            // Note: reasoning is not included in the thought content, only in the decision record
        });

        it('should include timestamps in decision thoughts', async () => {
            const beforeTime = Date.now();
            await wm.makeDecision('test', 'decision');
            const afterTime = Date.now();

            const state = wm.serialize();
            const decisionThought = state.thoughtChain.find(t => t.type === 'decision');

            expect(decisionThought?.timestamp).toBeDefined();
            const thoughtTime = new Date(decisionThought!.timestamp).getTime();
            expect(thoughtTime).toBeGreaterThanOrEqual(beforeTime);
            expect(thoughtTime).toBeLessThanOrEqual(afterTime);
        });
    });

    describe('Variable Management', () => {
        it('should set and get variables', async () => {
            await wm.setVariable('testVar', 'testValue');
            const value = await wm.getVariable('testVar');
            expect(value).toBe('testValue');
        });

        it('should handle complex variable types', async () => {
            const complexValue = { nested: { data: [1, 2, 3] } };
            await wm.setVariable('complex', complexValue);
            const retrieved = await wm.getVariable('complex');
            expect(retrieved).toEqual(complexValue);
        });

        it('should handle null and undefined values', async () => {
            await wm.setVariable('nullVar', null);
            await wm.setVariable('undefinedVar', undefined);

            expect(await wm.getVariable('nullVar')).toBeNull();
            expect(await wm.getVariable('undefinedVar')).toBeUndefined();
        });

        it('should return undefined for non-existent variables', async () => {
            const value = await wm.getVariable('nonexistent');
            expect(value).toBeUndefined();
        });

        it('should overwrite existing variables', async () => {
            await wm.setVariable('testVar', 'first');
            await wm.setVariable('testVar', 'second');

            const value = await wm.getVariable('testVar');
            expect(value).toBe('second');
        });

        it('should handle boolean and number types', async () => {
            await wm.setVariable('boolVar', true);
            await wm.setVariable('numVar', 42);

            expect(await wm.getVariable('boolVar')).toBe(true);
            expect(await wm.getVariable('numVar')).toBe(42);
        });
    });

    describe('State Serialization', () => {
        it('should serialize and load state', async () => {
            // Set up state
            await wm.setGoal('Test goal');
            await wm.addThought('Test thought');
            await wm.makeDecision('test', 'decision', 'reasoning');
            await wm.setVariable('var', 'value');

            // Serialize
            const serialized = wm.serialize();

            // Create new manager and load
            const wm2 = new WorkingMemoryManager('test-tenant', 'test-agent');
            wm2.load(serialized);

            // Verify
            expect(await wm2.getGoal()).toBe('Test goal');
            expect(await wm2.getThoughts()).toHaveLength(1);
            expect(await wm2.getDecision('test')).toBeDefined();
            expect(await wm2.getVariable('var')).toBe('value');
        });

        it('should serialize empty state correctly', async () => {
            const serialized = wm.serialize();

            expect(serialized.currentGoal).toBeNull();
            expect(serialized.thoughtChain).toEqual([]);
            expect(serialized.decisions).toEqual({});
            expect(serialized.variables).toEqual({});
        });

        it('should preserve complex data types in serialization', async () => {
            const complexData = {
                array: [1, 2, { nested: true }],
                object: { deep: { nesting: 'value' } },
                date: new Date().toISOString(),
                boolean: false,
                number: 3.14
            };

            await wm.setVariable('complex', complexData);

            const serialized = wm.serialize();
            const wm2 = new WorkingMemoryManager('test-tenant', 'test-agent');
            wm2.load(serialized);

            const retrieved = await wm2.getVariable('complex');
            expect(retrieved).toEqual(complexData);
        });

        it('should maintain thought chain order after serialization', async () => {
            await wm.addThought('First thought');
            await wm.makeDecision('key1', 'decision1');
            await wm.addThought('Second thought');
            await wm.makeDecision('key2', 'decision2');

            const serialized = wm.serialize();
            const wm2 = new WorkingMemoryManager('test-tenant', 'test-agent');
            wm2.load(serialized);

            // getThoughts() filters out decision-type entries, so only regular thoughts are returned
            const thoughts = await wm2.getThoughts();
            expect(thoughts).toHaveLength(2); // Only the 2 regular thoughts
            expect(thoughts[0].content).toBe('First thought');
            expect(thoughts[1].content).toBe('Second thought');

            // But the full thought chain in serialized state should have all 4 entries
            expect(serialized.thoughtChain).toHaveLength(4);
        });

        it('should handle loading invalid state gracefully', async () => {
            const invalidState = {
                currentGoal: { content: 'valid goal', timestamp: new Date().toISOString() },
                thoughtChain: 'invalid', // Should be array
                decisions: null, // Should be object
                variables: undefined // Should be object
            };

            // Should not throw
            expect(() => wm.load(invalidState as any)).not.toThrow();

            // Should load what it can
            expect(await wm.getGoal()).toBe('valid goal');
            // Note: The current implementation doesn't validate/fix invalid state, 
            // so this test verifies the current behavior
        });
    });

    describe('Integration Tests', () => {
        it('should handle complex workflow', async () => {
            // Simulate a complex agent workflow
            await wm.setGoal('Analyze user request and provide solution');

            await wm.addThought('User wants to implement authentication');
            await wm.setVariable('userRequest', 'implement auth');
            await wm.setVariable('complexity', 'medium');

            await wm.makeDecision('approach', 'use_oauth', 'More secure than custom auth');
            await wm.addThought('OAuth 2.0 would be best choice');

            await wm.setVariable('selectedProvider', 'google');
            await wm.makeDecision('provider', 'google', 'Most widely used');

            // Verify final state
            expect(await wm.getGoal()).toBe('Analyze user request and provide solution');
            expect(await wm.getThoughts()).toHaveLength(2); // Only regular thoughts (decisions filtered out)
            expect(await wm.getVariable('userRequest')).toBe('implement auth');
            expect(await wm.getVariable('selectedProvider')).toBe('google');
            const approachDecision = await wm.getDecision('approach');
            const providerDecision = await wm.getDecision('provider');
            expect(approachDecision?.decision).toBe('use_oauth');
            expect(providerDecision?.decision).toBe('google');
        });

        it('should maintain tenant and agent context', async () => {
            const wm1 = new WorkingMemoryManager('tenant1', 'agent1');
            const wm2 = new WorkingMemoryManager('tenant2', 'agent2');

            await wm1.setGoal('Goal for tenant1/agent1');
            await wm2.setGoal('Goal for tenant2/agent2');

            expect(await wm1.getGoal()).toBe('Goal for tenant1/agent1');
            expect(await wm2.getGoal()).toBe('Goal for tenant2/agent2');

            // Verify isolation
            const state1 = wm1.serialize();
            const state2 = wm2.serialize();
            expect(state1.currentGoal?.content).not.toBe(state2.currentGoal?.content);
        });
    });
}); 