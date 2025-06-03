import { describe, it, expect, beforeEach } from '@jest/globals';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import { globalAgentRegistry } from '../src/core/plugin/AgentRegistry.js';
import type { AgentPlugin } from '../src/core/plugin/types.js';

describe('PluginManager', () => {
    beforeEach(() => {
        // Clear the global registry before each test
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

    describe('registerAgent', () => {
        it('should register an agent successfully', () => {
            const agent = createMockAgent('test-agent');

            PluginManager.registerAgent(agent);

            const found = PluginManager.findAgent('test-agent');
            expect(found).toBe(agent);
        });

        it('should handle registration errors gracefully', () => {
            const invalidAgent = {
                manifest: null,
                handleTask: async () => ({}),
                tenantId: 'test'
            } as any;

            expect(() => {
                PluginManager.registerAgent(invalidAgent);
            }).toThrow();
        });
    });

    describe('findAgent', () => {
        beforeEach(() => {
            PluginManager.registerAgent(createMockAgent('hello-agent'));
            PluginManager.registerAgent(createMockAgent('data-processor'));
        });

        it('should find agent by exact name', () => {
            const agent = PluginManager.findAgent('hello-agent');
            expect(agent?.manifest.name).toBe('hello-agent');
        });

        it('should find agent by alias', () => {
            const agent = PluginManager.findAgent('hello');
            expect(agent?.manifest.name).toBe('hello-agent');
        });

        it('should find agent by fuzzy matching', () => {
            const agent = PluginManager.findAgent('data');
            expect(agent?.manifest.name).toBe('data-processor');
        });

        it('should return null for non-existent agent', () => {
            const agent = PluginManager.findAgent('non-existent');
            expect(agent).toBeNull();
        });
    });

    describe('listAgents', () => {
        it('should return empty array when no agents registered', () => {
            const agents = PluginManager.listAgents();
            expect(agents).toEqual([]);
        });

        it('should return all registered agent manifests', () => {
            const agent1 = createMockAgent('agent1');
            const agent2 = createMockAgent('agent2');

            PluginManager.registerAgent(agent1);
            PluginManager.registerAgent(agent2);

            const manifests = PluginManager.listAgents();
            expect(manifests).toHaveLength(2);
            expect(manifests.map(m => m.name)).toContain('agent1');
            expect(manifests.map(m => m.name)).toContain('agent2');
        });
    });

    describe('integration with AgentRegistry', () => {
        it('should use the global agent registry', () => {
            const agent = createMockAgent('integration-test');

            PluginManager.registerAgent(agent);

            // Should be findable through both PluginManager and direct registry access
            expect(PluginManager.findAgent('integration-test')).toBe(agent);
            expect(globalAgentRegistry.findByName('integration-test')).toBe(agent);
        });
    });
}); 