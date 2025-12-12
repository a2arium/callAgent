import { logger } from '@a2arium/callagent-utils';
import {
    AgentResultCache,
    ArtifactImpl,
    hydrateArtifacts,
    isArtifactMarker,
    type ArtifactMarker
} from '@a2arium/callagent-memory-engine';
import type { MentalState, ObservationInbox } from '../loop/types.js';
import type { ObservationConfig } from '../loop/oneTurn.js';

const log = logger.createLogger({ prefix: 'ArtifactHydrationService' });

export const ARTIFACT_HYDRATION_DEPTH_LIMIT = 12;
export const HYDRATED_ARTIFACT_HANDLE_SYMBOL = Symbol('hydratedArtifactHandle');

export class ArtifactHydrationService {

    /**
     * Hydrate artifacts within an observation inbox
     */
    static hydrateInboxArtifacts<T extends ObservationConfig>(
        inbox: ObservationInbox<T>,
        prisma: unknown,
        tenantId: string,
        contextLabel: string
    ): ObservationInbox<T> {
        if (!prisma) return inbox;
        try {
            const cache = new AgentResultCache(prisma as any);
            return hydrateArtifacts(inbox, cache, tenantId) as ObservationInbox<T>;
        } catch (err) {
            log.warn('Failed to hydrate inbox artifacts', {
                context: contextLabel,
                error: err instanceof Error ? err.message : String(err)
            });
            return inbox;
        }
    }

    /**
     * Hydrate artifacts within a mental state
     */
    static hydrateMentalStateArtifacts(
        mental: MentalState | undefined,
        prisma: unknown,
        tenantId: string,
        contextLabel: string
    ): MentalState | undefined {
        if (!prisma || !mental) return mental;
        try {
            const cache = new AgentResultCache(prisma as any);
            return hydrateArtifacts(mental, cache, tenantId) as MentalState;
        } catch (err) {
            log.warn('Failed to hydrate mental state artifacts', {
                context: contextLabel,
                error: err instanceof Error ? err.message : String(err)
            });
            return mental;
        }
    }

    /**
     * Try to hydrate artifacts in a child task result
     */
    static tryHydrateChildResult(result: unknown, cache: AgentResultCache | undefined, tenantId: string): void {
        if (!cache || !result || typeof result !== 'object') {
            return;
        }

        try {
            this.attachHydratedArtifactHandles(result, cache, tenantId);
        } catch (error) {
            log.warn('hydrateArtifacts failed for child result', {
                error: error instanceof Error ? error.message : String(error),
                tenantId
            });
        }
    }

    /**
     * Recursively attach hydrated artifact handles to objects
     */
    static attachHydratedArtifactHandles(
        obj: unknown,
        cache: AgentResultCache,
        tenantId: string,
        depth = 0,
        visited = new WeakSet<object>()
    ): void {
        if (!obj || typeof obj !== 'object' || depth > ARTIFACT_HYDRATION_DEPTH_LIMIT) {
            return;
        }

        if (visited.has(obj as object)) {
            return;
        }

        visited.add(obj as object);

        if (isArtifactMarker(obj)) {
            this.annotateArtifactMarker(obj as ArtifactMarker, cache, tenantId);
            return;
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                this.attachHydratedArtifactHandles(item, cache, tenantId, depth + 1, visited);
            }
            return;
        }

        const record = obj as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            this.attachHydratedArtifactHandles(record[key], cache, tenantId, depth + 1, visited);
        }
    }

    private static annotateArtifactMarker(marker: ArtifactMarker, cache: AgentResultCache, tenantId: string): ArtifactImpl {
        const existing = (marker as any)[HYDRATED_ARTIFACT_HANDLE_SYMBOL] as ArtifactImpl | undefined;
        if (existing) return existing;

        const handle = new ArtifactImpl(marker.id, cache, tenantId, marker.mimeType, marker.estimatedSize);
        const descriptor = { enumerable: false, configurable: true, writable: false };
        Object.defineProperty(marker, HYDRATED_ARTIFACT_HANDLE_SYMBOL, { ...descriptor, value: handle });
        Object.defineProperty(marker, 'then', { ...descriptor, value: handle.then.bind(handle) });
        Object.defineProperty(marker, 'load', { ...descriptor, value: handle.load.bind(handle) });
        Object.defineProperty(marker, 'set', { ...descriptor, value: handle.set.bind(handle) });
        return handle;
    }
}
