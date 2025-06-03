import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { globalAgentRegistry } from '../src/core/plugin/AgentRegistry.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import type { AgentPlugin } from '../src/core/plugin/types.js';

describe('Runner Agent Registration Integration', () => {
    beforeEach(() => {
        // Clear the global registry before each test
        const registry = globalAgentRegistry as any;
        registry.agents.clear();
        registry.aliases.clear();
    });

    afterEach(() => {
        // Clean up after each test
        const registry = globalAgentRegistry as any;
        registry.agents.clear();
        registry.aliases.clear();
    });

    const createMockAgent = (name: string, version: string = '1.0.0'): AgentPlugin => ({
        manifest: {
            name,
            version,
            description: `Test agent ${name}`
        },
        handleTask: async () => ({ result: 'test' }),
        tenantId: 'test-tenant'
    });

    describe('Agent Registration Flow', () => {
        it('should register agent and make it discoverable', () => {
            const agent = createMockAgent('test-runner-agent');

            // Simulate what the runner does
            PluginManager.registerAgent(agent);

            // Verify the agent is registered and discoverable
            const foundByExactName = PluginManager.findAgent('test-runner-agent');
            expect(foundByExactName).toBe(agent);

            // Verify alias creation
            const foundByAlias = PluginManager.findAgent('test-runner');
            expect(foundByAlias).toBe(agent);

            // Verify it's in the list
            const allAgents = PluginManager.listAgents();
            expect(allAgents).toHaveLength(1);
            expect(allAgents[0].name).toBe('test-runner-agent');
        });

        it('should handle multiple agent registrations', () => {
            const agent1 = createMockAgent('hello-agent', '1.0.0');
            const agent2 = createMockAgent('data-processor', '2.0.0');
            const agent3 = createMockAgent('ai_assistant', '1.5.0');

            // Register multiple agents (simulating multiple runner instances)
            PluginManager.registerAgent(agent1);
            PluginManager.registerAgent(agent2);
            PluginManager.registerAgent(agent3);

            // Verify all are registered
            expect(PluginManager.findAgent('hello-agent')).toBe(agent1);
            expect(PluginManager.findAgent('data-processor')).toBe(agent2);
            expect(PluginManager.findAgent('ai_assistant')).toBe(agent3);

            // Verify aliases work
            expect(PluginManager.findAgent('hello')).toBe(agent1);

            // Verify fuzzy matching works
            expect(PluginManager.findAgent('data')).toBe(agent2);
            expect(PluginManager.findAgent('ai-assistant')).toBe(agent3);

            // Verify listing
            const allAgents = PluginManager.listAgents();
            expect(allAgents).toHaveLength(3);
            expect(allAgents.map(a => a.name)).toContain('hello-agent');
            expect(allAgents.map(a => a.name)).toContain('data-processor');
            expect(allAgents.map(a => a.name)).toContain('ai_assistant');
        });

        it('should handle agent overwriting gracefully', () => {
            const agent1 = createMockAgent('test-agent', '1.0.0');
            const agent2 = createMockAgent('test-agent', '2.0.0');

            // Register first version
            PluginManager.registerAgent(agent1);
            expect(PluginManager.findAgent('test-agent')).toBe(agent1);

            // Register second version (should overwrite)
            PluginManager.registerAgent(agent2);
            expect(PluginManager.findAgent('test-agent')).toBe(agent2);
            expect(PluginManager.findAgent('test-agent')?.manifest.version).toBe('2.0.0');

            // Should still only have one agent in the list
            const allAgents = PluginManager.listAgents();
            expect(allAgents).toHaveLength(1);
            expect(allAgents[0].version).toBe('2.0.0');
        });

        it('should maintain registry state across operations', () => {
            const agent1 = createMockAgent('persistent-agent');
            const agent2 = createMockAgent('another-agent');

            // Register first agent
            PluginManager.registerAgent(agent1);
            expect(PluginManager.listAgents()).toHaveLength(1);

            // Register second agent
            PluginManager.registerAgent(agent2);
            expect(PluginManager.listAgents()).toHaveLength(2);

            // Verify both are still findable
            expect(PluginManager.findAgent('persistent-agent')).toBe(agent1);
            expect(PluginManager.findAgent('another-agent')).toBe(agent2);

            // Verify direct registry access works too
            expect(globalAgentRegistry.findByName('persistent-agent')).toBe(agent1);
            expect(globalAgentRegistry.findByName('another-agent')).toBe(agent2);
        });
    });

    describe('Registry Features Verification', () => {
        it('should support all discovery methods', () => {
            const agent = createMockAgent('complex-data-agent', '1.0.0');
            PluginManager.registerAgent(agent);

            // Exact name
            expect(PluginManager.findAgent('complex-data-agent')).toBe(agent);

            // Alias (removes -agent suffix)
            expect(PluginManager.findAgent('complex-data')).toBe(agent);

            // Fuzzy matching
            expect(PluginManager.findAgent('complex')).toBe(agent);
            expect(PluginManager.findAgent('data')).toBe(agent);

            // Case insensitive fuzzy matching
            expect(PluginManager.findAgent('COMPLEX')).toBe(agent);
            expect(PluginManager.findAgent('Data')).toBe(agent);
        });

        it('should handle edge cases in agent names', () => {
            const agents = [
                createMockAgent('simple'),
                createMockAgent('with-hyphens'),
                createMockAgent('with_underscores'),
                createMockAgent('MixedCase'),
                createMockAgent('numbers123'),
            ];

            agents.forEach(agent => PluginManager.registerAgent(agent));

            // Verify all are findable
            agents.forEach(agent => {
                expect(PluginManager.findAgent(agent.manifest.name)).toBe(agent);
            });

            // Verify fuzzy matching works with different separators
            expect(PluginManager.findAgent('with_hyphens')).toBe(agents[1]);
            expect(PluginManager.findAgent('with-underscores')).toBe(agents[2]);
            expect(PluginManager.findAgent('mixedcase')).toBe(agents[3]);
            expect(PluginManager.findAgent('numbers')).toBe(agents[4]);
        });
    });
}); 