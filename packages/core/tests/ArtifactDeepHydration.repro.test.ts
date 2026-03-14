import { jest } from '@jest/globals';
import { A2AService } from '../src/orchestration/A2AService.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { ARTIFACT_MARKER_KIND } from '@a2arium/callagent-memory-engine';

describe('Artifact Deep Hydration (Reproduction)', () => {
    let service: A2AService;

    beforeEach(() => {
        jest.spyOn(A2AService.prototype as any, 'initializeCacheService').mockResolvedValue(undefined);
        service = new A2AService();

        const mockAgent = {
            manifest: { name: 'target-agent', version: '1.0.0', cache: { enabled: true } },
            resolved: {
                agentCard: { name: 'target-agent', version: '1.0.0' },
                runtimeManifest: { name: 'target-agent', version: '1.0.0', cache: { enabled: true } }
            },
            handleTask: jest.fn()
        };
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(mockAgent as any);
        jest.spyOn(EngineLocator, 'getEngine').mockReturnValue({
            attachWorkingMemory: jest.fn(),
            flushContextSnapshot: jest.fn(),
            handleChildCompleted: jest.fn()
        } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should allow awaiting nested artifacts in cached results', async () => {
        const artifactContent = '<html><body>Hello World</body></html>';

        // Mock cache to return a nested artifact marker
        const mockCache = {
            getCachedResult: jest.fn().mockResolvedValue({
                status: 'completed',
                data: {
                    htmlContent: {
                        kind: ARTIFACT_MARKER_KIND,
                        id: 'art-123',
                        mimeType: 'text/html'
                    }
                }
            }),
            // Mock getCachedResult for the artifact retrieval itself
            // ArtifactImpl.load calls getCachedResult('artifact_store', { artifactId: 'art-123' }, ...)
            setCachedResult: jest.fn()
        };

        // We need to double-mock getCachedResult: once for the agent result, once for the artifact
        (mockCache.getCachedResult as jest.Mock)
            .mockResolvedValueOnce({
                status: 'completed',
                data: {
                    htmlContent: {
                        kind: ARTIFACT_MARKER_KIND,
                        id: 'art-123',
                        mimeType: 'text/html'
                    }
                }
            })
            .mockResolvedValueOnce(artifactContent);

        (service as any).agentResultCache = mockCache;

        // Execute A2A call which hits cache
        const result: any = await service.sendTaskToAgent(
            { tenantId: 't1', agentId: 'source', task: { id: 'task-1', input: {} } } as any,
            'target-agent',
            {},
            { cache: { enabled: true } }
        );

        const htmlMarker = result.data.htmlContent;
        expect(htmlMarker.kind).toBe(ARTIFACT_MARKER_KIND);

        // TEST 1: Check if .then exists (this was confirmed in the previous test, but good to re-verify)
        expect(typeof htmlMarker.then).toBe('function');

        // TEST 2: Check if awaiting it resolves to the content
        // If the bug exists as described, 'await' might return the marker itself if 'then' is missing or broken
        const resolvedHtml = await result.data.htmlContent;

        if (typeof resolvedHtml === 'object' && resolvedHtml?.kind === ARTIFACT_MARKER_KIND) {
            throw new Error('FAILED: await returned the artifact marker instead of resolving it. Hydration might be a plain object without a functioning thenable.');
        }

        expect(resolvedHtml).toBe(artifactContent);
    });
});
