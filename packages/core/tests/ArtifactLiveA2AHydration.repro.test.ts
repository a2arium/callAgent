import { jest } from '@jest/globals';
import { A2AService } from '../src/orchestration/A2AService.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { ARTIFACT_MARKER_KIND } from '@a2arium/callagent-memory-engine';

describe('Artifact Live A2A Hydration (Reproduction)', () => {
    let service: A2AService;

    beforeEach(() => {
        jest.spyOn(A2AService.prototype as any, 'initializeCacheService').mockResolvedValue(undefined);
        service = new A2AService();
        // Inject mock cache service which is required for hydration
        (service as any).agentResultCache = {
            loadArtifact: jest.fn(),
            storeArtifact: jest.fn()
        };

        // MOCK AGENT returns a result with an inert marker
        const mockAgent = {
            manifest: { name: 'target-agent', version: '1.0.0', cache: { enabled: false } },
            handleTask: jest.fn().mockResolvedValue({
                status: 'completed',
                data: {
                    htmlContent: {
                        kind: ARTIFACT_MARKER_KIND,
                        id: 'live-art-123',
                        mimeType: 'text/html'
                    }
                }
            })
        };
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(mockAgent as any);
        jest.spyOn(EngineLocator, 'getEngine').mockReturnValue({
            attachWorkingMemory: jest.fn(),
            flushContextSnapshot: jest.fn(),
            handleChildCompleted: jest.fn(),
            getSessionStorePrisma: () => ({}) // Dummy prisma
        } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should hydrate artifacts in LIVE results from subagents', async () => {
        // Execute A2A call (LIVE, no cache)
        const result: any = await service.sendTaskToAgent(
            { tenantId: 't1', agentId: 'source', task: { id: 'task-1', input: {} } } as any,
            'target-agent',
            {},
            { cache: { enabled: false } }
        );

        const htmlMarker = result.data.htmlContent;
        expect(htmlMarker.kind).toBe(ARTIFACT_MARKER_KIND);

        // This is where it fails if A2AService doesn't hydrate live results
        if (typeof htmlMarker.then !== 'function') {
            throw new Error('FAILED: Live A2A result was not hydrated. Artifact marker is inert.');
        }

        expect(typeof htmlMarker.then).toBe('function');
    });
});
