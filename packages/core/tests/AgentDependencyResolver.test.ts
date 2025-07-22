import { AgentDependencyResolver, DependencyResolutionError } from '../src/core/plugin/dependencies/AgentDependencyResolver.js';
import { SmartAgentDiscoveryService } from './__mocks__/SmartAgentDiscoveryService.js';
import { ManifestValidator } from './__mocks__/ManifestValidator.js';
import { AgentManifest } from '@a2arium/types';
// Mock the dependencies
jest.mock('node:fs/promises', () => ({
    readFile: jest.fn()
}));

import fs from 'node:fs/promises';

const mockFs = fs as any;
const mockSmartAgentDiscoveryService = SmartAgentDiscoveryService as jest.Mocked<typeof SmartAgentDiscoveryService>;
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

        mockSmartAgentDiscoveryService.validateAgentStructure.mockResolvedValue({
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
            mockSmartAgentDiscoveryService.findManifest
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
            mockSmartAgentDiscoveryService.findManifest.mockImplementation(async (agentName: string) =>
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

            mockSmartAgentDiscoveryService.findManifest.mockImplementation(async (agentName: string) =>
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

            mockSmartAgentDiscoveryService.findManifest
                .mockResolvedValueOnce('/path/to/coordinator-agent.json')
                .mockResolvedValueOnce(null); // missing agent

            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(coordinatorManifest));

            mockSmartAgentDiscoveryService.validateAgentStructure
                .mockResolvedValueOnce({ isValid: true, errors: [] })
                .mockResolvedValueOnce({ isValid: false, errors: ['Agent file not found'] }); // missing agent

            await expect(AgentDependencyResolver.resolveDependencies('coordinator-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should handle agent with no dependencies', async () => {
            const simpleManifest: AgentManifest = {
                name: 'simple-agent',
                version: '1.0.0'
            };

            mockSmartAgentDiscoveryService.findManifest
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
    });

    describe('loadManifest', () => {
        it('should load manifest from file', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test-agent.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.loadManifest('test-agent');

            expect(result).toEqual(manifest);
            expect(mockSmartAgentDiscoveryService.findManifest).toHaveBeenCalledWith('test-agent', undefined);
            expect(mockFs.readFile).toHaveBeenCalledWith('/path/to/test-agent.json', 'utf-8');
        });

        it('should throw error if manifest file not found', async () => {
            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue(null);

            await expect(AgentDependencyResolver.loadManifest('missing-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error if manifest is invalid JSON', async () => {
            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/invalid.json');
            mockFs.readFile.mockResolvedValue('invalid json');

            await expect(AgentDependencyResolver.loadManifest('invalid-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error if manifest validation fails', async () => {
            const invalidManifest = { name: 'test' }; // Missing required fields

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(invalidManifest));
            mockManifestValidator.validate.mockReturnValue({
                isValid: false,
                errors: ['Missing version field'],
                warnings: []
            });

            await expect(AgentDependencyResolver.loadManifest('test-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });
    });

    describe('getImmediateDependencies', () => {
        it('should return dependencies from manifest', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0',
                dependencies: { agents: ['dep1', 'dep2'] }
            };

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual(['dep1', 'dep2']);
        });

        it('should return empty array if no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual([]);
        });

        it('should return empty array on error', async () => {
            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue(null);

            const result = await AgentDependencyResolver.getImmediateDependencies('missing-agent');

            expect(result).toEqual([]);
        });
    });

    describe('hasDependencies', () => {
        it('should return true if agent has dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0',
                dependencies: { agents: ['dep1'] }
            };

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(true);
        });

        it('should return false if agent has no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockSmartAgentDiscoveryService.findManifest.mockResolvedValue('/path/to/test.json');
            mockFs.readFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(false);
        });
    });
}); 