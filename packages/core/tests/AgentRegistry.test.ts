import { describe, it, expect, beforeEach } from '@jest/globals';
import { AgentRegistry } from '../src/core/plugin/AgentRegistry.js';
import type { AgentPlugin } from '../src/core/plugin/types.js';

describe('AgentRegistry', () => {
    let registry: AgentRegistry;

    beforeEach(() => {
        registry = new AgentRegistry();
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

    describe('register', () => {
        it('should register an agent successfully', () => {
            const agent = createMockAgent('test-agent');

            registry.register(agent);

            const found = registry.findByName('test-agent');
            expect(found).toBe(agent);
        });

        it('should create aliases for agents ending with -agent', () => {
            const agent = createMockAgent('hello-agent');

            registry.register(agent);

            // Should find by full name
            expect(registry.findByName('hello-agent')).toBe(agent);
            // Should find by alias
            expect(registry.findByName('hello')).toBe(agent);
        });

        it('should warn when overwriting existing agent', () => {
            const agent1 = createMockAgent('test-agent', '1.0.0');
            const agent2 = createMockAgent('test-agent', '2.0.0');

            registry.register(agent1);
            registry.register(agent2);

            const found = registry.findByName('test-agent');
            expect(found).toBe(agent2);
            expect(found?.manifest.version).toBe('2.0.0');
        });
    });

    describe('findByName', () => {
        beforeEach(() => {
            registry.register(createMockAgent('hello-agent'));
            registry.register(createMockAgent('data-processor'));
            registry.register(createMockAgent('ai_assistant'));
        });

        it('should find agent by exact name', () => {
            const agent = registry.findByName('hello-agent');
            expect(agent?.manifest.name).toBe('hello-agent');
        });

        it('should find agent by alias', () => {
            const agent = registry.findByName('hello');
            expect(agent?.manifest.name).toBe('hello-agent');
        });

        it('should find agent by fuzzy matching', () => {
            const agent = registry.findByName('data');
            expect(agent?.manifest.name).toBe('data-processor');
        });

        it('should handle underscores and hyphens in fuzzy matching', () => {
            const agent = registry.findByName('ai-assistant');
            expect(agent?.manifest.name).toBe('ai_assistant');
        });

        it('should return null for non-existent agent', () => {
            const agent = registry.findByName('non-existent');
            expect(agent).toBeNull();
        });
    });

    describe('listAgents', () => {
        it('should return empty array when no agents registered', () => {
            const agents = registry.listAgents();
            expect(agents).toEqual([]);
        });

        it('should return all registered agent manifests', () => {
            const agent1 = createMockAgent('agent1');
            const agent2 = createMockAgent('agent2');

            registry.register(agent1);
            registry.register(agent2);

            const manifests = registry.listAgents();
            expect(manifests).toHaveLength(2);
            expect(manifests.map(m => m.name)).toContain('agent1');
            expect(manifests.map(m => m.name)).toContain('agent2');
        });
    });
}); 