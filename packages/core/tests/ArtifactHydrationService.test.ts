import { jest } from '@jest/globals';

// Mock dependencies BEFORE importing the module under test
await jest.unstable_mockModule('@a2arium/callagent-memory-engine', () => ({
    AgentResultCache: jest.fn(),
    ArtifactImpl: jest.fn(() => ({
        then: jest.fn(),
        load: jest.fn(),
        set: jest.fn(),
    })),
    isArtifactMarker: (obj: any) => obj && obj.__isArtifactMarker,
    hydrateArtifacts: jest.fn((obj) => obj), // Passthrough by default
}));

// Dynamic import after mocking
const { ArtifactHydrationService, HYDRATED_ARTIFACT_HANDLE_SYMBOL } = await import('../src/orchestration/ArtifactHydrationService.js');
const { AgentResultCache, ArtifactImpl } = await import('@a2arium/callagent-memory-engine');

describe('ArtifactHydrationService', () => {
    let mockCache: any;

    beforeEach(() => {
        mockCache = new (AgentResultCache as any)();
        jest.clearAllMocks();
    });

    describe('attachHydratedArtifactHandles', () => {
        it('should hydrate artifact markers in a nested object', () => {
            const marker = { id: 'art-1', __isArtifactMarker: true, mimeType: 'text/plain' };
            const obj = {
                nested: {
                    artifact: marker
                }
            };

            ArtifactHydrationService.attachHydratedArtifactHandles(obj, mockCache, 'test-tenant');

            // Verify symbol is attached
            expect((marker as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL]).toBeDefined();
            // Verify ArtifactImpl was instantiated
            expect(ArtifactImpl).toHaveBeenCalledWith('art-1', mockCache, 'test-tenant', 'text/plain', undefined);
        });

        it('should handle circular references gracefully', () => {
            const marker = { id: 'art-1', __isArtifactMarker: true };
            const obj: any = { marker };
            obj.self = obj; // Circular

            ArtifactHydrationService.attachHydratedArtifactHandles(obj, mockCache, 'test-tenant');

            expect((marker as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL]).toBeDefined();
        });

        it('should stop at depth limit', () => {
            // Create a deeply nested object
            let current: any = { leaf: { id: 'deep-art', __isArtifactMarker: true } };
            for (let i = 0; i < 15; i++) {
                current = { next: current };
            }

            ArtifactHydrationService.attachHydratedArtifactHandles(current, mockCache, 'test-tenant');

            // The deep artifact should NOT be hydrated if depth limit (12) is exceeded
            // 15 > 12
            // We need to traverse to find the leaf.
            // Wait, we need to inspect the leaf.
            // Let's grab the leaf reference
            let leaf = current;
            while (leaf.next) leaf = leaf.next;
            leaf = leaf.leaf;

            expect((leaf as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL]).toBeUndefined();
        });
    });

    describe('tryHydrateChildResult', () => {
        it('should hydrate artifacts in child result', () => {
            const result = { output: { file: { id: 'file-1', __isArtifactMarker: true } } };
            ArtifactHydrationService.tryHydrateChildResult(result, mockCache, 'test-tenant');
            expect((result.output.file as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL]).toBeDefined();
        });

        it('should do nothing if cache is undefined', () => {
            const result = { output: { file: { id: 'file-1', __isArtifactMarker: true } } };
            ArtifactHydrationService.tryHydrateChildResult(result, undefined, 'test-tenant');
            expect((result.output.file as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL]).toBeUndefined();
        });
    });
});
