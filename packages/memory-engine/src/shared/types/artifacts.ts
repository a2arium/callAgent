import { v4 as uuidv4 } from 'uuid';

export const ARTIFACT_MARKER_KIND = 'artifact';
export const LOCAL_ARTIFACT_KIND = 'artifact_local';

// 1. The internal handle (stored in DB, lazy loaded)
export interface ArtifactHandle<T = unknown> extends PromiseLike<T> {
    kind: typeof ARTIFACT_MARKER_KIND;
    id?: string;
    mimeType?: string;
    estimatedSize?: number;
    set(value: T): Promise<void>;
    load(): Promise<T>;
}

// 2. The local wrapper (stored in RAM, resolves immediately)
export interface LocalArtifact<T = unknown> extends PromiseLike<T> {
    kind: typeof LOCAL_ARTIFACT_KIND;
    /** Stable identity used to publish cloned copies exactly once. */
    publicationId?: string;
    value: T;
    mimeType?: string;
}

const inferMimeType = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        return 'text/plain';
    }
    // Node Buffer or Uint8Array / ArrayBuffer views
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return 'application/octet-stream';
    }
    if (value instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value as ArrayBufferView))) {
        return 'application/octet-stream';
    }
    if (value !== null && typeof value === 'object') {
        return 'application/json';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return 'text/plain';
    }
    return undefined;
};

// 3. The unified union type (what users see)
export type Artifact<T = unknown> = T | LocalArtifact<T> | ArtifactHandle<T>;

// Static Factory for creating LocalArtifacts
export const Artifact = {
    create: <T>(value: T, options?: { mimeType?: string }): LocalArtifact<T> => {
        const mimeType = options?.mimeType ?? inferMimeType(value);
        return {
            kind: LOCAL_ARTIFACT_KIND,
            publicationId: uuidv4(),
            value,
            mimeType,
            then<TResult1 = T, TResult2 = never>(
                onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
            ): PromiseLike<TResult1 | TResult2> {
                return Promise.resolve(value).then(onfulfilled, onrejected);
            }
        };
    }
};
