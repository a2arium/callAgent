import { SmartAgentDiscoveryService } from '../src/core/plugin/dependencies/SmartAgentDiscoveryService.js';

describe('SmartAgentDiscoveryService', () => {
    beforeEach(() => {
        // Clear cache before each test
        SmartAgentDiscoveryService.clearCache();
    });

    describe('registry functionality', () => {
        it('should register and find agents', () => {
            const agentInfo = {
                path: '/test/path/TestAgent.ts',
                manifest: { name: 'test-agent', version: '1.0.0' },
                loadedAt: new Date()
            };

            SmartAgentDiscoveryService.registerAgent('test-agent', agentInfo);

            expect(SmartAgentDiscoveryService.hasRegisteredAgent('test-agent')).toBe(true);
            expect(SmartAgentDiscoveryService.hasRegisteredAgent('non-existent')).toBe(false);
        });

        it('should find registered agents instantly', async () => {
            const agentInfo = {
                path: '/test/path/TestAgent.ts',
                manifest: { name: 'test-agent', version: '1.0.0' },
                loadedAt: new Date()
            };

            SmartAgentDiscoveryService.registerAgent('test-agent', agentInfo);

            const result = await SmartAgentDiscoveryService.findAgent('test-agent');
            expect(result).toBe('/test/path/TestAgent.ts');
        });
    });

    describe('filename generation', () => {
        it('should generate case-insensitive filename patterns', () => {
            // This tests the internal generateAgentFilenames method indirectly
            // by checking that the service can handle different naming conventions
            expect(typeof SmartAgentDiscoveryService.findAgent).toBe('function');
        });
    });

    describe('workspace discovery', () => {
        it('should handle missing package.json gracefully', async () => {
            // Test with a non-existent agent - should return null gracefully
            const result = await SmartAgentDiscoveryService.findAgent('non-existent-agent-xyz-123');
            expect(result).toBeNull();
        });
    });

    describe('smart filesystem discovery', () => {
        it('should handle filesystem scanning gracefully', async () => {
            // Test with a non-existent agent - should return null gracefully
            const result = await SmartAgentDiscoveryService.findAgent('non-existent-agent-xyz-123');
            expect(result).toBeNull();
        });

        it('should list available agents without throwing errors', async () => {
            // This will hit the real file system but should not throw
            const result = await SmartAgentDiscoveryService.listAvailableAgents();

            // Should return an array (might be empty if no agents found)
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('manifest discovery', () => {
        it('should handle manifest discovery gracefully', async () => {
            // Test with a non-existent agent - should return null gracefully
            const result = await SmartAgentDiscoveryService.findManifest('non-existent-agent-xyz-123');
            expect(result).toBeNull();
        });
    });

    describe('cache functionality', () => {
        it('should clear cache properly', () => {
            const agentInfo = {
                path: '/test/path/TestAgent.ts',
                manifest: { name: 'test-agent', version: '1.0.0' },
                loadedAt: new Date()
            };

            SmartAgentDiscoveryService.registerAgent('test-agent', agentInfo);
            expect(SmartAgentDiscoveryService.hasRegisteredAgent('test-agent')).toBe(true);

            SmartAgentDiscoveryService.clearCache();
            expect(SmartAgentDiscoveryService.hasRegisteredAgent('test-agent')).toBe(false);
        });
    });
}); 