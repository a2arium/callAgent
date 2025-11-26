import type { AgentResultCache } from '../../cache/AgentResultCache.js';
import { ArtifactImpl, isArtifactMarker } from '../../orchestration/ArtifactImpl.js';
import { LOCAL_ARTIFACT_KIND, type LocalArtifact, ARTIFACT_MARKER_KIND } from '../../../shared/types/artifacts.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'serialization' });

/**
 * Deeply serializes an object for MentalState snapshots.
 * - Offloads LocalArtifacts to storage and replaces them with Markers.
 * - Converts ArtifactImpl instances to Markers.
 * - Handles circular references gracefully.
 * - Returns a deep copy (does not mutate original).
 */
export async function serializeVars(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    visited = new WeakMap<object, unknown>()
): Promise<unknown> {
    // 1. Handle Primitives
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    // 2. Handle Circular References
    if (visited.has(obj as object)) {
        // Return undefined or a placeholder for circular refs to avoid [Circular] string
        // returning undefined causes it to be dropped from JSON, which is usually safest
        return undefined; 
    }

    // 3. Handle LocalArtifact (The content-heavy object from Artifact.create)
    if ((obj as any).kind === LOCAL_ARTIFACT_KIND) {
        const local = obj as LocalArtifact;
        try {
            // Store the content
            const { size, artifactId } = await cache.storeArtifact(
                tenantId,
                undefined,
                local.value,
                local.mimeType
            );
            
            // Create the marker
            return {
                kind: ARTIFACT_MARKER_KIND,
                id: artifactId,
                mimeType: local.mimeType,
                estimatedSize: size
            };
        } catch (err) {
            log.error('Failed to offload LocalArtifact during serialization', err);
            return null; // Fail safe
        }
    }

    // 4. Handle ArtifactImpl (The handle)
    if (obj instanceof ArtifactImpl) {
        // In the future, we could await obj.ensureOffloaded() here if implemented
        // For now, we assume handles created via ctx.artifacts are already saved
        return obj.toJSON();
    }
    
    // 5. Handle Pre-existing Markers (Already serialized)
    if (isArtifactMarker(obj)) {
        return { ...obj }; // Clone marker
    }

    // Register visit before recursing
    visited.set(obj as object, true);

    // 6. Handle Arrays
    if (Array.isArray(obj)) {
        const result: unknown[] = [];
        for (const item of obj) {
            const serialized = await serializeVars(item, cache, tenantId, visited);
            if (serialized !== undefined) {
                result.push(serialized);
            }
        }
        return result;
    }

    // 7. Handle Plain Objects
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const serialized = await serializeVars(value, cache, tenantId, visited);
        if (serialized !== undefined) {
            result[key] = serialized;
        }
    }

    return result;
}

