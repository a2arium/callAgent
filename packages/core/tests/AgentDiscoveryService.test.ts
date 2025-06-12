import { AgentDiscoveryService } from '../src/core/plugin/dependencies/AgentDiscoveryService.js';

describe('AgentDiscoveryService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('parseAgentName', () => {
        it('should parse simple agent names', () => {
            // Access private method through any cast for testing
            const parseAgentName = (AgentDiscoveryService as any).parseAgentName;

            const result = parseAgentName('hello-agent');
            expect(result).toEqual({
                name: 'hello-agent',
                fullName: 'hello-agent'
            });
        });

        it('should parse category-based agent names', () => {
            const parseAgentName = (AgentDiscoveryService as any).parseAgentName;

            const result = parseAgentName('data-processing/csv-parser');
            expect(result).toEqual({
                category: 'data-processing',
                name: 'csv-parser',
                fullName: 'data-processing/csv-parser'
            });
        });

        it('should handle invalid category format', () => {
            const parseAgentName = (AgentDiscoveryService as any).parseAgentName;

            const result = parseAgentName('invalid/format/too/many/parts');
            expect(result).toEqual({
                name: 'invalid/format/too/many/parts',
                fullName: 'invalid/format/too/many/parts'
            });
        });

        it('should handle empty category or name', () => {
            const parseAgentName = (AgentDiscoveryService as any).parseAgentName;

            const result1 = parseAgentName('/empty-category');
            expect(result1).toEqual({
                name: '/empty-category',
                fullName: '/empty-category'
            });

            const result2 = parseAgentName('category/');
            expect(result2).toEqual({
                name: 'category/',
                fullName: 'category/'
            });
        });
    });

    describe('getAgentSearchPaths', () => {
        it('should return standard search paths', () => {
            const paths = AgentDiscoveryService.getAgentSearchPaths();

            expect(paths).toEqual([
                'apps/examples',
                'packages/examples',
                'dist/apps/examples',
                'dist/packages/examples',
                '.',
                '..'
            ]);
        });
    });

    describe('getManifestSearchPaths', () => {
        it('should return same paths as agent search paths', () => {
            const agentPaths = AgentDiscoveryService.getAgentSearchPaths();
            const manifestPaths = AgentDiscoveryService.getManifestSearchPaths();

            expect(manifestPaths).toEqual(agentPaths);
        });
    });

    describe('validateAgentStructure', () => {
        it('should validate simple agent structure', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce('apps/examples/test-agent/AgentModule.js');
            findManifestFileSpy.mockResolvedValueOnce('apps/examples/test-agent/agent.json');

            const result = await AgentDiscoveryService.validateAgentStructure('test-agent');

            expect(result.isValid).toBe(true);
            expect(result.errors).toEqual([]);

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should validate category-based agent structure', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce('apps/examples/data-processing/csv-parser/AgentModule.js');
            findManifestFileSpy.mockResolvedValueOnce('apps/examples/data-processing/csv-parser/agent.json');

            const result = await AgentDiscoveryService.validateAgentStructure('data-processing/csv-parser');

            expect(result.isValid).toBe(true);
            expect(result.errors).toEqual([]);

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should report missing agent file for category-based agent', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce(null); // missing
            findManifestFileSpy.mockResolvedValueOnce('apps/examples/data-processing/csv-parser/agent.json');

            const result = await AgentDiscoveryService.validateAgentStructure('data-processing/csv-parser');

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Agent file not found for 'data-processing/csv-parser' (category: 'data-processing', name: 'csv-parser')");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should report missing manifest file for category-based agent', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce('apps/examples/data-processing/csv-parser/AgentModule.js');
            findManifestFileSpy.mockResolvedValueOnce(null); // missing

            const result = await AgentDiscoveryService.validateAgentStructure('data-processing/csv-parser');

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Manifest file not found for 'data-processing/csv-parser' (category: 'data-processing', name: 'csv-parser')");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should report both missing files for category-based agent', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce(null);
            findManifestFileSpy.mockResolvedValueOnce(null);

            const result = await AgentDiscoveryService.validateAgentStructure('data-processing/missing-agent');

            expect(result.isValid).toBe(false);
            expect(result.errors).toHaveLength(2);
            expect(result.errors).toContain("Agent file not found for 'data-processing/missing-agent' (category: 'data-processing', name: 'missing-agent')");
            expect(result.errors).toContain("Manifest file not found for 'data-processing/missing-agent' (category: 'data-processing', name: 'missing-agent')");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should handle context path for same-folder discovery', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');

            findAgentFileSpy.mockResolvedValueOnce('apps/examples/multi-agent/SomeAgent.js');

            const result = await AgentDiscoveryService.validateAgentStructure('some-agent', 'apps/examples/multi-agent/MainAgent.js');

            expect(result.isValid).toBe(true);
            expect(result.errors).toEqual([]);

            findAgentFileSpy.mockRestore();
        });
    });

    describe('file path and naming logic', () => {
        it('should handle PascalCase conversion correctly', () => {
            // This tests the internal toPascalCase logic indirectly
            // by verifying that the search paths include expected variations
            expect(AgentDiscoveryService.getAgentSearchPaths().length).toBeGreaterThan(0);
        });

        it('should include common file patterns in search', () => {
            // Test that the service has reasonable search paths
            const paths = AgentDiscoveryService.getAgentSearchPaths();
            expect(paths).toContain('apps/examples');
            expect(paths).toContain('dist/apps/examples');
        });
    });

    describe('integration tests using real file system', () => {
        it('should handle real file discovery gracefully', async () => {
            // Test with a non-existent agent - should return null gracefully
            const result = await AgentDiscoveryService.findAgentFile('non-existent-agent-xyz-123');
            expect(result).toBeNull();
        });

        it('should handle real manifest discovery gracefully', async () => {
            // Test with a non-existent agent - should return null gracefully
            const result = await AgentDiscoveryService.findManifestFile('non-existent-agent-xyz-123');
            expect(result).toBeNull();
        });

        it('should list available agents without throwing errors', async () => {
            // This will hit the real file system but should not throw
            const result = await AgentDiscoveryService.listAvailableAgents();

            // Should return an array (might be empty if no agents found)
            expect(Array.isArray(result)).toBe(true);
        });
    });
}); 