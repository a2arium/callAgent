import { v4 as uuidv4 } from 'uuid';
import type { ArtifactHandle } from '../shared/types/artifacts.js';
import { ARTIFACT_MARKER_KIND } from '../shared/types/artifacts.js';
import type { AgentResultCache } from '../cache/AgentResultCache.js';

/**
 * Runtime implementation of the ArtifactHandle<T>.
 * Persists the value via AgentResultCache and serializes to a lightweight marker.
 */
export class ArtifactImpl<T = unknown> implements ArtifactHandle<T> {
    readonly kind = ARTIFACT_MARKER_KIND;
    private _pendingWrite: Promise<void> | null = null;

    constructor(
        public id: string | undefined,
        private cache: AgentResultCache | Promise<AgentResultCache>,
        private tenantId: string,
        public mimeType?: string,
        public estimatedSize?: number
    ) { }

    private async getCache(): Promise<AgentResultCache> {
        if (this.cache instanceof Promise) {
            this.cache = await this.cache;
        }
        return this.cache;
    }

    async set(value: T): Promise<void> {
        if (!this.id) {
            this.id = uuidv4();
        }

        this._pendingWrite = (async () => {
            const cache = await this.getCache();
            const stored = await cache.storeArtifact(
                this.tenantId,
                this.id,
                value,
                this.mimeType
            );
            this.id = stored.artifactId;
            this.estimatedSize = stored.size;
        })();

        return this._pendingWrite;
    }

    async load(): Promise<T> {
        if (this._pendingWrite) {
            await this._pendingWrite;
        }
        if (!this.id) {
            throw new Error('Artifact has no ID (not saved)');
        }

        const cache = await this.getCache();
        const result = await cache.getCachedResult<T>(
            'artifact_store',
            { artifactId: this.id },
            [],
            this.tenantId
        );

        if (result === null) {
            throw new Error(`Artifact not found in storage (ID: ${this.id})`);
        }

        return result;
    }

    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        return this.load().then(onfulfilled, onrejected);
    }

    toJSON(): ArtifactMarker {
        if (!this.id) {
            return { kind: ARTIFACT_MARKER_KIND, id: '', mimeType: this.mimeType, estimatedSize: this.estimatedSize };
        }

        return {
            kind: ARTIFACT_MARKER_KIND,
            id: this.id,
            mimeType: this.mimeType,
            estimatedSize: this.estimatedSize
        };
    }
}

export interface ArtifactMarker {
    kind: typeof ARTIFACT_MARKER_KIND;
    id: string;
    mimeType?: string;
    estimatedSize?: number;
}

export function isArtifactMarker(value: unknown): value is ArtifactMarker {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as ArtifactMarker).kind === ARTIFACT_MARKER_KIND &&
        typeof (value as ArtifactMarker).id === 'string'
    );
}
