import { jest } from '@jest/globals';
import { A2AService } from '../src/orchestration/A2AService.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { mock } from 'jest-mock-extended';
import type { AgentPlugin } from '../src/plugin/types.js';
import { ARTIFACT_MARKER_KIND } from '@a2arium/callagent-memory-engine';

describe('A2AService Artifact Hydration (Reproduction)', () => {
    let service: A2AService;
    let mockAgent: AgentPlugin;

    beforeEach(() => {
        // Prevent real cache initialization attempting to overwrite our mock
        jest.spyOn(A2AService.prototype as any, 'initializeCacheService').mockResolvedValue(undefined);

        service = new A2AService();

        // Mock Agent Plugin
        mockAgent = {
            manifest: {
                name: 'test-agent',
                version: '1.0.0',
                cache: { enabled: true, ttlSeconds: 60 }
            },
            resolved: {
                agentCard: { name: 'test-agent', version: '1.0.0' },
                runtimeManifest: { name: 'test-agent', version: '1.0.0', cache: { enabled: true, ttlSeconds: 60 } }
            },
            handleTask: jest.fn().mockResolvedValue({ status: 'completed' })
        } as unknown as AgentPlugin;

        // Mock PluginManager.findAgent
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(mockAgent);

        // Mock EngineLocator to bypass check
        jest.spyOn(EngineLocator, 'getEngine').mockReturnValue({
            attachWorkingMemory: jest.fn(),
            flushContextSnapshot: jest.fn(),
            handleChildCompleted: jest.fn()
        } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should hydrate artifacts when returning cached results', async () => {
        // 1. Setup Mock Cache
        const mockCache = {
            getCachedResult: jest.fn().mockResolvedValue({
                status: 'completed',
                output: {
                    file: {
                        kind: ARTIFACT_MARKER_KIND,
                        id: 'artifact-123',
                        mimeType: 'text/plain',
                        estimatedSize: 100
                    }
                }
            }),
            setCachedResult: jest.fn()
        };

        // Inject mock cache into service (private property)
        (service as any).agentResultCache = mockCache;

        // 2. Execute A2A Call
        const result: any = await service.sendTaskToAgent(
            {
                tenantId: 'test-tenant',
                agentId: 'source-agent',
                task: { id: 'task-1', input: {} } as any
            } as any,
            'test-agent',
            {},
            { cache: { enabled: true } }
        );

        // 3. Verify Cache Was Hit
        expect(mockCache.getCachedResult).toHaveBeenCalled();
        expect(mockAgent.handleTask).not.toHaveBeenCalled();

        // Debug logging
        console.log('Result from A2AService:', JSON.stringify(result, null, 2));
        if (result?.output?.file) {
            console.log('File keys:', Object.keys(result.output.file));
            console.log('File prototype:', Object.getPrototypeOf(result.output.file));
            console.log('Symbol keys:', Object.getOwnPropertySymbols(result.output.file).map(s => s.toString()));
        }

        // 4. Assert Artifact Hydration
        // BUG: Currently this receives a plain object, so result.output.file.load will be undefined
        expect(result.output.file).toBeDefined();

        // This is the assertion that fails due to the bug
        if (typeof result.output.file.load !== 'function') {
            throw new Error('Artifact was not hydrated! Missing .load() method on cached artifact result.');
        }

        expect(typeof result.output.file.load).toBe('function');
        expect(result.output.file.id).toBe('artifact-123');
    });
});
