import { ArtifactImpl, isArtifactMarker } from '../artifacts/ArtifactImpl.js';
import type { AgentResultCache } from '../cache/AgentResultCache.js';

/**
 * Recursively scan an object for Artifact markers and replace them with ArtifactImpl instances.
 * 
 * @param obj The object to scan (mutated in place if possible, or returned)
 * @param cache The cache service to bind to new ArtifactImpls
 * @param tenantId The tenant ID context
 * @param depth Recursion depth limit (default: 10)
 * @returns The hydrated object
 */
export function hydrateArtifacts(obj: unknown, cache: AgentResultCache, tenantId: string, depth = 0): unknown {
    if (!obj || typeof obj !== 'object' || depth > 10) {
        return obj;
    }

    // If it's an artifact marker, hydrate it
    if (isArtifactMarker(obj)) {
        return new ArtifactImpl(
            obj.id,
            cache,
            tenantId,
            obj.mimeType,
            obj.estimatedSize
        );
    }

    // If array, map it
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = hydrateArtifacts(obj[i], cache, tenantId, depth + 1);
        }
        return obj;
    }

    // If object, iterate keys
    // We only iterate own enumerable properties
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            (obj as any)[key] = hydrateArtifacts((obj as any)[key], cache, tenantId, depth + 1);
        }
    }

    return obj;
}

