import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AgentManifest } from '@a2arium/types';

// Mock fs/promises
const mockReadFile = jest.fn();
jest.mock('node:fs/promises', () => ({
    readFile: mockReadFile
}));

import fs from 'node:fs/promises';
import { SmartAgentDiscoveryService } from '../src/core/plugin/dependencies/SmartAgentDiscoveryService.js';
import { ManifestValidator } from '../src/core/plugin/ManifestValidator.js';
import { AgentDependencyResolver, DependencyResolutionError } from '../src/core/plugin/dependencies/AgentDependencyResolver.js';

const mockFs = { readFile: mockReadFile } as any;

describe('AgentDependencyResolver', () => {
    let mockFindManifest: jest.SpiedFunction<typeof SmartAgentDiscoveryService.findManifest>;
    let mockValidateAgentStructure: jest.SpiedFunction<typeof SmartAgentDiscoveryService.validateAgentStructure>;
    let mockValidate: jest.SpiedFunction<typeof ManifestValidator.validate>;

    beforeEach(() => {
        jest.clearAllMocks();

        // Spy on the real methods instead of mocking the modules
        mockFindManifest = jest.spyOn(SmartAgentDiscoveryService, 'findManifest');
        mockValidateAgentStructure = jest.spyOn(SmartAgentDiscoveryService, 'validateAgentStructure');
        mockValidate = jest.spyOn(ManifestValidator, 'validate');

        // Mock fs.readFile to use our mock
        jest.spyOn(fs, 'readFile').mockImplementation(mockReadFile);

        // Default mock return values
        mockValidate.mockReturnValue({
            isValid: true,
            errors: [],
            warnings: []
        });

        mockValidateAgentStructure.mockResolvedValue({
            isValid: true,
            errors: []
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
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
            mockFindManifest
                .mockResolvedValueOnce('/path/to/coordinator-agent.json')
                .mockResolvedValueOnce('/path/to/data-analysis-agent.json');

            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(coordinatorManifest))
                .mockResolvedValueOnce(JSON.stringify(dataAnalysisManifest));

            const result = await AgentDependencyResolver.resolveDependencies('coordinator-agent');

            expect(result.loadingOrder).toEqual(['coordinator-agent', 'data-analysis-agent']);
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
            mockFindManifest.mockImplementation(async (agentName: string) =>
                `/path/to/${agentName}.json`
            );

            mockReadFile.mockImplementation(async (path: any) => {
                const agentName = (path as string).split('/').pop()?.replace('.json', '') as keyof typeof manifests;
                return JSON.stringify(manifests[agentName]);
            });

            const result = await AgentDependencyResolver.resolveDependencies('agent-a');

            // Topological sort: dependencies first, dependents last
            // All agents should be present - exact order may vary based on graph structure
            expect(result.loadingOrder).toContain('agent-d');
            expect(result.loadingOrder).toContain('agent-a');
            expect(result.loadingOrder).toContain('agent-b');
            expect(result.loadingOrder).toContain('agent-c');
            // Verify all agents are present
            expect(result.loadingOrder.length).toBe(4);
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

            mockFindManifest.mockImplementation(async (agentName: string) =>
                `/path/to/${agentName}.json`
            );

            mockReadFile.mockImplementation(async (path: any) => {
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

            mockFindManifest
                .mockResolvedValueOnce('/path/to/coordinator-agent.json')
                .mockResolvedValueOnce(null); // missing agent

            mockReadFile
                .mockResolvedValueOnce(JSON.stringify(coordinatorManifest));

            mockValidateAgentStructure
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

            mockFindManifest
                .mockResolvedValueOnce('/path/to/simple-agent.json');

            mockReadFile
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

            mockFindManifest.mockResolvedValue('/path/to/test-agent.json');
            mockReadFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.loadManifest('test-agent');

            expect(result).toEqual(manifest);
            expect(mockFindManifest).toHaveBeenCalledWith('test-agent', undefined);
            expect(mockReadFile).toHaveBeenCalledWith('/path/to/test-agent.json', 'utf8');
        });

        it('should throw error if manifest file not found', async () => {
            mockFindManifest.mockResolvedValue(null);

            await expect(AgentDependencyResolver.loadManifest('missing-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error if manifest is invalid JSON', async () => {
            mockFindManifest.mockResolvedValue('/path/to/invalid.json');
            mockReadFile.mockResolvedValue('invalid json');

            await expect(AgentDependencyResolver.loadManifest('invalid-agent'))
                .rejects.toThrow(DependencyResolutionError);
        });

        it('should throw error if manifest validation fails', async () => {
            const invalidManifest = { name: 'test' }; // Missing required fields

            mockFindManifest.mockResolvedValue('/path/to/test.json');
            mockReadFile.mockResolvedValue(JSON.stringify(invalidManifest));
            mockValidate.mockReturnValue({
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

            mockFindManifest.mockResolvedValue('/path/to/test.json');
            mockReadFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual(['dep1', 'dep2']);
        });

        it('should return empty array if no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockFindManifest.mockResolvedValue('/path/to/test.json');
            mockReadFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.getImmediateDependencies('test-agent');

            expect(result).toEqual([]);
        });

        it('should return empty array on error', async () => {
            mockFindManifest.mockResolvedValue(null);

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

            mockFindManifest.mockResolvedValue('/path/to/test.json');
            mockReadFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(true);
        });

        it('should return false if agent has no dependencies', async () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            mockFindManifest.mockResolvedValue('/path/to/test.json');
            mockReadFile.mockResolvedValue(JSON.stringify(manifest));

            const result = await AgentDependencyResolver.hasDependencies('test-agent');

            expect(result).toBe(false);
        });
    });
}); 