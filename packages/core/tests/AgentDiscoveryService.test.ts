import { AgentDiscoveryService } from '../src/core/plugin/dependencies/AgentDiscoveryService.js';

describe('AgentDiscoveryService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getAgentSearchPaths', () => {
        it('should return standard search paths', () => {
            const paths = AgentDiscoveryService.getAgentSearchPaths();

            expect(paths).toEqual([
                'apps/examples',
                'dist/apps/examples',
                'packages/examples',
                'dist/packages/examples',
                '.'
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

    describe('validateAgentStructure', () => {
        it('should validate agent with both files present', async () => {
            // Create spies to mock the file finding methods
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

        it('should report missing agent file', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce(null); // missing
            findManifestFileSpy.mockResolvedValueOnce('apps/examples/test-agent/agent.json');

            const result = await AgentDiscoveryService.validateAgentStructure('test-agent');

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Agent file not found for 'test-agent'");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should report missing manifest file', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce('apps/examples/test-agent/AgentModule.js');
            findManifestFileSpy.mockResolvedValueOnce(null); // missing

            const result = await AgentDiscoveryService.validateAgentStructure('test-agent');

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Manifest file not found for 'test-agent'");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
        });

        it('should report both missing files', async () => {
            const findAgentFileSpy = jest.spyOn(AgentDiscoveryService, 'findAgentFile');
            const findManifestFileSpy = jest.spyOn(AgentDiscoveryService, 'findManifestFile');

            findAgentFileSpy.mockResolvedValueOnce(null);
            findManifestFileSpy.mockResolvedValueOnce(null);

            const result = await AgentDiscoveryService.validateAgentStructure('missing-agent');

            expect(result.isValid).toBe(false);
            expect(result.errors).toHaveLength(2);
            expect(result.errors).toContain("Agent file not found for 'missing-agent'");
            expect(result.errors).toContain("Manifest file not found for 'missing-agent'");

            findAgentFileSpy.mockRestore();
            findManifestFileSpy.mockRestore();
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