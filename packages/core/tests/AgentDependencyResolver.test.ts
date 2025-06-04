import { AgentDependencyResolver, DependencyResolutionError } from '../src/core/plugin/dependencies/AgentDependencyResolver.js';
import { AgentDiscoveryService } from '../src/core/plugin/dependencies/AgentDiscoveryService.js';
import { ManifestValidator } from '../src/core/plugin/ManifestValidator.js';
import { AgentManifest } from '@callagent/types';
import fs from 'node:fs/promises';

// Mock the dependencies
jest.mock('node:fs/promises');
jest.mock('../src/core/plugin/dependencies/AgentDiscoveryService.js');
jest.mock('../src/core/plugin/ManifestValidator.js');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockAgentDiscoveryService = AgentDiscoveryService as jest.Mocked<typeof AgentDiscoveryService>;
const mockManifestValidator = ManifestValidator as jest.Mocked<typeof ManifestValidator>;

describe('AgentDependencyResolver', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Default mocks
        mockManifestValidator.validate.mockReturnValue({
            isValid: true,
            errors: [],
            warnings: []
        });

        mockAgentDiscoveryService.validateAgentStructure.mockResolvedValue({
            isValid: true,
            errors: []
        });
    });

    describe('resolveDependencies', () => {
        it('should resolve simple dependency chain', async () => {
            // Setup manifests: coordinator -> data-analysis -> (no deps)
            const coordinatorManifest: AgentManifest = {
                name: 'coordinator-agent',
                version: '1.0.0',
                dependencies: { agents: ['data-analysis-agent'] }
            };

            const dataAnalysisManifest: AgentManifest = {
                name: 'data-analysis-agent',
                version: '1.0.0'
            };

            // Mock file reading
            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/coordinator-agent.json')
                .mockResolvedValueOnce('/path/to/data-analysis-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(coordinatorManifest))
                .mockResolvedValueOnce(JSON.stringify(dataAnalysisManifest));

            const result = await AgentDependencyResolver.resolveDependencies('coordinator-agent');

            expect(result.loadingOrder).toEqual(['data-analysis-agent', 'coordinator-agent']);
            expect(result.allAgents).toEqual(['coordinator-agent', 'data-analysis-agent']);
            expect(result.warnings).toEqual([]);
            expect(result.dependencyGraph.get('coordinator-agent')).toEqual(['data-analysis-agent']);
            expect(result.dependencyGraph.get('data-analysis-agent')).toEqual([]);
        });

        it('should resolve complex dependency graph', async () => {
            // Setup manifests: A -> [B, C], B -> D, C -> D, D -> (no deps)
            const manifests = {
                'agent-a': { name: 'agent-a', version: '1.0.0', dependencies: { agents: ['agent-b', 'agent-c'] } },
                'agent-b': { name: 'agent-b', version: '1.0.0', dependencies: { agents: ['agent-d'] } },
                'agent-c': { name: 'agent-c', version: '1.0.0', dependencies: { agents: ['agent-d'] } },
                'agent-d': { name: 'agent-d', version: '1.0.0' }
            };

            // Mock file reading for all agents
            mockAgentDiscoveryService.findManifestFile.mockImplementation(async (agentName: string) =>
                `/path/to/${agentName}.json`
            );

            mockFs.readFile.mockImplementation(async (path: any) => {
                const agentName = (path as string).split('/').pop()?.replace('.json', '') as keyof typeof manifests;
                return JSON.stringify(manifests[agentName]);
            });

            const result = await AgentDependencyResolver.resolveDependencies('agent-a');

            // agent-d should be first (no dependencies), then agent-b and agent-c, then agent-a
            expect(result.loadingOrder).toEqual(['agent-d', 'agent-b', 'agent-c', 'agent-a']);
            expect(result.allAgents).toContain('agent-a');
            expect(result.allAgents).toContain('agent-b');
            expect(result.allAgents).toContain('agent-c');
            expect(result.allAgents).toContain('agent-d');
        });

        it('should detect circular dependencies', async () => {
            // Setup circular dependency: A -> B -> C -> A
            const manifests = {
                'agent-a': { name: 'agent-a', version: '1.0.0', dependencies: { agents: ['agent-b'] } },
                'agent-b': { name: 'agent-b', version: '1.0.0', dependencies: { agents: ['agent-c'] } },
                'agent-c': { name: 'agent-c', version: '1.0.0', dependencies: { agents: ['agent-a'] } }
            };

            mockAgentDiscoveryService.findManifestFile.mockImplementation(async (agentName: string) =>
                `/path/to/${agentName}.json`
            );

            mockFs.readFile.mockImplementation(async (path: any) => {
                const agentName = (path as string).split('/').pop()?.replace('.json', '') as keyof typeof manifests;
                return JSON.stringify(manifests[agentName]);
            });

            await expect(AgentDependencyResolver.resolveDependencies('agent-a'))
                .rejects.toThrow(DependencyResolutionError);

            try {
                await AgentDependencyResolver.resolveDependencies('agent-a');
            } catch (error) {
                expect(error).toBeInstanceOf(DependencyResolutionError);
                expect((error as DependencyResolutionError).message).toContain('Circular dependency detected');
            }
        });

        it('should throw error for missing dependency', async () => {
            const coordinatorManifest: AgentManifest = {
                name: 'coordinator-agent',
                version: '1.0.0',
                dependencies: { agents: ['missing-agent'] }
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/coordinator-agent.json')
                .mockResolvedValueOnce(null); // missing agent

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(coordinatorManifest));

            mockAgentDiscoveryService.validateAgentStructure
                .mockResolvedValueOnce({ isValid: true, errors: [] })
                .mockResolvedValueOnce({ isValid: false, errors: ['Agent file not found'] });

            await expect(AgentDependencyResolver.resolveDependencies('coordinator-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should handle agent with no dependencies', async () => {
            const simpleManifest: AgentManifest = {
                name: 'simple-agent',
                version: '1.0.0'
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/simple-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(simpleManifest));

            const result = await AgentDependencyResolver.resolveDependencies('simple-agent');

            expect(result.loadingOrder).toEqual(['simple-agent']);
            expect(result.allAgents).toEqual(['simple-agent']);
            expect(result.dependencyGraph.get('simple-agent')).toEqual([]);
        });
    });

    describe('detectCircularDependencies', () => {
        it('should detect simple circular dependency', () => {
            const graph = new Map([
                ['a', ['b']],
                ['b', ['a']]
            ]);

            const result = AgentDependencyResolver.detectCircularDependencies(graph);

            expect(result).not.toBeNull();
            expect(result).toContain('a');
            expect(result).toContain('b');
        });

        it('should detect complex circular dependency', () => {
            const graph = new Map([
                ['a', ['b']],
                ['b', ['c']],
                ['c', ['d']],
                ['d', ['b']] // Creates cycle b -> c -> d -> b
            ]);

            const result = AgentDependencyResolver.detectCircularDependencies(graph);

            expect(result).not.toBeNull();
            expect(result).toEqual(['b', 'c', 'd']);
        });

        it('should return null for acyclic graph', () => {
            const graph = new Map([
                ['a', ['b', 'c']],
                ['b', ['d']],
                ['c', ['d']],
                ['d', []]
            ]);

            const result = AgentDependencyResolver.detectCircularDependencies(graph);

            expect(result).toBeNull();
        });

        it('should handle empty graph', () => {
            const graph = new Map();

            const result = AgentDependencyResolver.detectCircularDependencies(graph);

            expect(result).toBeNull();
        });
    });

    describe('loadManifest', () => {
        it('should load and validate manifest successfully', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.loadManifest('test-agent');

            expect(result).toEqual(manifest);
            expect(mockManifestValidator.validate).toHaveBeenCalledWith(manifest);
        });

        it('should throw error when manifest file not found', async () => {
            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce(null);

            await expect(AgentDependencyResolver.loadManifest('missing-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error for invalid JSON', async () => {
            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce('invalid json');

            await expect(AgentDependencyResolver.loadManifest('test-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error for invalid manifest structure', async () => {
            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify({ invalid: 'manifest' }));

            await expect(AgentDependencyResolver.loadManifest('test-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error for manifest validation failure', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            mockManifestValidator.validate.mockReturnValueOnce({
                isValid: false,
                errors: ['Invalid manifest'],
                warnings: []
            });

            await expect(AgentDependencyResolver.loadManifest('test-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });
    });

    describe('getImmediateDependencies', () => {
        it('should return dependencies for agent with dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0',
                dependencies: { agents: ['dep1', 'dep2'] }
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual(['dep1', 'dep2']);
        });

        it('should return empty array for agent with no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual([]);
        });

        it('should return empty array on error', async () => {
            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce(null);

            const result = await AgentDependencyResolver.getImmediateDependencies('missing-agent');

            expect(result).toEqual([]);
        });
    });

    describe('hasDependencies', () => {
        it('should return true for agent with dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0',
                dependencies: { agents: ['dep1'] }
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(true);
        });

        it('should return false for agent with no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockAgentDiscoveryService.findManifestFile
                .mockResolvedValueOnce('/path/to/test-agent.json');

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(false);
        });
    });
}); 