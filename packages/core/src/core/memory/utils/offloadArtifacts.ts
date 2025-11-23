import { ARTIFACT_MARKER_KIND, LOCAL_ARTIFACT_KIND, type LocalArtifact } from '../../../shared/types/artifacts.js';
import type { AgentResultCache } from '../../cache/AgentResultCache.js';
import { ArtifactImpl } from '../../orchestration/ArtifactImpl.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'offloadArtifacts' });

/**
 * Recursively walks an object tree, finding LocalArtifacts, offloading them to the cache,
 * and replacing them with ArtifactHandles (ArtifactImpl instances).
 * 
 * This function mutates the object tree in place if it's an array or object,
 * but returns the new value for primitives or the root object.
 */
export async function offloadArtifacts(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    depth = 0
): Promise<unknown> {
    if (!obj || typeof obj !== 'object' || depth > 20) {
        return obj;
    }

    // Check if it is a LocalArtifact
    // We check for the kind property explicitly
    if ((obj as any).kind === LOCAL_ARTIFACT_KIND) {
        log.info('Found LocalArtifact, offloading...', { mimeType: (obj as any).mimeType });
        const local = obj as LocalArtifact;
        const { size, artifactId } = await cache.storeArtifact(
            tenantId,
            undefined, // Let cache generate ID
            local.value,
            local.mimeType
        );

        // Create a proper handle that can be awaited
        const handle = new ArtifactImpl(
            artifactId,
            cache, // Pass cache instance directly
            tenantId,
            local.mimeType,
            size
        );

        log.info('Offloaded artifact', { id: artifactId, size });
        // Persist the lightweight marker (non-thenable) to avoid Promise assimilation
        const marker = handle.toJSON();
        return {
            kind: ARTIFACT_MARKER_KIND,
            id: marker.id,
            mimeType: marker.mimeType,
            estimatedSize: marker.estimatedSize
        };
    }

    // Handle Arrays
    if (Array.isArray(obj)) {
        await Promise.all(obj.map(async (item, index) => {
            obj[index] = await offloadArtifacts(item, cache, tenantId, depth + 1);
        }));
        return obj;
    }

    // Handle Objects
    // We use Object.entries to iterate and wait for all promises
    const entries = Object.entries(obj);
    await Promise.all(entries.map(async ([key, value]) => {
        (obj as any)[key] = await offloadArtifacts(value, cache, tenantId, depth + 1);
    }));

    return obj;
}

