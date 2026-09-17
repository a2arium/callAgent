import { ARTIFACT_MARKER_KIND, LOCAL_ARTIFACT_KIND, type LocalArtifact } from '../shared/types/artifacts.js';
import type { AgentResultCache } from '../cache/AgentResultCache.js';
import { ArtifactImpl, isArtifactMarker } from '../artifacts/ArtifactImpl.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'offloadArtifacts' });

/**
 * Recursively walks an object tree, finding LocalArtifacts, offloading them to the cache,
 * and replacing them with ArtifactHandles (ArtifactImpl instances).
 * 
 * This function mutates the object tree in place if it's an array or object,
 * but returns the new value for primitives or the root object.
 */
const MAX_DEPTH = 20;

async function offloadArtifactsInternal(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    depth: number,
    seenArtifacts: WeakMap<object, Promise<unknown>>,
    visited: WeakSet<object>
): Promise<unknown> {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    if (depth > MAX_DEPTH) {
        return obj;
    }

    // Check for LocalArtifacts BEFORE checking visited
    // This allows duplicate references to the same artifact to be properly replaced
    if ((obj as any).kind === LOCAL_ARTIFACT_KIND) {
        // log.info('Found LocalArtifact, offloading...', { mimeType: (obj as any).mimeType });
        if (seenArtifacts.has(obj as object)) {
            return seenArtifacts.get(obj as object);
        }
        const local = obj as LocalArtifact;
        const upload = (async () => {
            try {
                const { size, artifactId } = local.publicationId
                    ? await cache.publishArtifact(
                        tenantId,
                        local.publicationId,
                        local.value,
                        local.mimeType
                    )
                    : await cache.storeArtifact(
                        tenantId,
                        undefined,
                        local.value,
                        local.mimeType
                    );

                const handle = new ArtifactImpl(
                    artifactId,
                    cache,
                    tenantId,
                    local.mimeType,
                    size
                );

                log.info('Offloaded artifact', { id: artifactId, size });
                const marker = handle.toJSON();
                return {
                    kind: ARTIFACT_MARKER_KIND,
                    id: marker.id,
                    mimeType: marker.mimeType,
                    estimatedSize: marker.estimatedSize
                };
            } catch (err) {
                log.error('Failed to offload artifact', { error: err instanceof Error ? err.message : String(err) });
                if (
                    err && typeof err === 'object' &&
                    (err as { code?: unknown }).code === 'ARTIFACT_PUBLICATION_CONFLICT'
                ) {
                    throw err;
                }
                return obj; // Return original if failed
            }
        })();
        seenArtifacts.set(obj as object, upload);
        return upload;
    }

    // Check visited AFTER artifact handling to allow duplicates to be replaced
    if (visited.has(obj as object)) {
        return obj;
    }
    visited.add(obj as object);

    if (Array.isArray(obj)) {
        for (let index = 0; index < obj.length; index++) {
            obj[index] = await offloadArtifactsInternal(obj[index], cache, tenantId, depth + 1, seenArtifacts, visited);
        }
        return obj;
    }

    // Sequential iteration for object properties
    const entries = Object.entries(obj);
    for (const [key, value] of entries) {
        (obj as any)[key] = await offloadArtifactsInternal(value, cache, tenantId, depth + 1, seenArtifacts, visited);
    }

    return obj;
}

export async function offloadArtifacts(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    depth = 0
): Promise<unknown> {
    // FAST PATH: If the JSON string doesn't contain the marker, skip traversal.
    // This is safe because LocalArtifacts must have kind='artifact_local'.
    try {
        const str = JSON.stringify(obj);
        if (!str || !str.includes(LOCAL_ARTIFACT_KIND)) {
            log.info('Fast path: No local artifacts found in snapshot.');
            return obj;
        }
    } catch {
        // If circular structure prevents stringify, fall back to traversal
        log.debug('Fast path skipped due to JSON.stringify error (circular?)');
    }

    const seenArtifacts = new WeakMap<object, Promise<unknown>>();
    const visited = new WeakSet<object>();
    return offloadArtifactsInternal(obj, cache, tenantId, depth, seenArtifacts, visited);
}
