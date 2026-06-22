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

    it('should ignore cached task wrappers that are not terminal', async () => {
        const mockCache = {
            getCachedResult: jest.fn().mockResolvedValue({
                id: 'child-task-1',
                input: { url: 'https://example.test' },
                status: { state: 'working', timestamp: '2026-06-20T05:00:01.809Z' }
            }),
            setCachedResult: jest.fn()
        };
        (service as any).agentResultCache = mockCache;

        const liveResult = { ok: true, data: { html: '<html>fresh</html>' } };
        (mockAgent.handleTask as jest.Mock).mockResolvedValueOnce(liveResult);

        const result: any = await service.sendTaskToAgent(
            {
                tenantId: 'test-tenant',
                agentId: 'source-agent',
                task: { id: 'task-1', input: {} } as any
            } as any,
            'test-agent',
            { url: 'https://example.test' },
            { cache: { enabled: true } }
        );

        expect(mockCache.getCachedResult).toHaveBeenCalled();
        expect(mockAgent.handleTask).toHaveBeenCalledTimes(1);
        expect(result).toEqual(liveResult);
        expect(mockCache.setCachedResult).toHaveBeenCalledWith(
            'test-agent',
            { url: 'https://example.test' },
            liveResult,
            60,
            [],
            'test-tenant'
        );
    });

    it('should unwrap completed cached task wrappers to their terminal result', async () => {
        const terminalResult = { ok: true, data: { html: '<html>cached</html>' } };
        const mockCache = {
            getCachedResult: jest.fn().mockResolvedValue({
                id: 'child-task-1',
                input: { url: 'https://example.test' },
                status: {
                    state: 'completed',
                    timestamp: '2026-06-20T05:00:01.809Z',
                    metadata: { result: terminalResult }
                }
            }),
            setCachedResult: jest.fn()
        };
        (service as any).agentResultCache = mockCache;

        const result: any = await service.sendTaskToAgent(
            {
                tenantId: 'test-tenant',
                agentId: 'source-agent',
                task: { id: 'task-1', input: {} } as any
            } as any,
            'test-agent',
            { url: 'https://example.test' },
            { cache: { enabled: true } }
        );

        expect(mockCache.getCachedResult).toHaveBeenCalled();
        expect(mockAgent.handleTask).not.toHaveBeenCalled();
        expect(result).toEqual(terminalResult);
    });
});
