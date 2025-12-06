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
const MAX_DEPTH = 20;

async function offloadArtifactsInternal(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    depth: number,
    seenArtifacts: WeakMap<object, Promise<unknown>>
): Promise<unknown> {
    if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) {
        return obj;
    }

    if ((obj as any).kind === LOCAL_ARTIFACT_KIND) {
        log.info('Found LocalArtifact, offloading...', { mimeType: (obj as any).mimeType });
        if (seenArtifacts.has(obj as object)) {
            return seenArtifacts.get(obj as object);
        }
        const local = obj as LocalArtifact;
        const upload = (async () => {
            const { size, artifactId } = await cache.storeArtifact(
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
        })();
        seenArtifacts.set(obj as object, upload);
        return upload;
    }

    if (Array.isArray(obj)) {
        await Promise.all(obj.map(async (item, index) => {
            obj[index] = await offloadArtifactsInternal(item, cache, tenantId, depth + 1, seenArtifacts);
        }));
        return obj;
    }

    const entries = Object.entries(obj);
    await Promise.all(entries.map(async ([key, value]) => {
        (obj as any)[key] = await offloadArtifactsInternal(value, cache, tenantId, depth + 1, seenArtifacts);
    }));

    return obj;
}

export async function offloadArtifacts(
    obj: unknown,
    cache: AgentResultCache,
    tenantId: string,
    depth = 0
): Promise<unknown> {
    const seenArtifacts = new WeakMap<object, Promise<unknown>>();
    return offloadArtifactsInternal(obj, cache, tenantId, depth, seenArtifacts);
}
