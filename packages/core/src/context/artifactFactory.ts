import {
    AgentResultCache,
    ArtifactImpl,
    type ArtifactHandle,
} from '@a2arium/callagent-memory-engine';
import type { TaskContext } from '../shared/types/index.js';

export const ARTIFACT_STORAGE_UNAVAILABLE = 'ARTIFACT_STORAGE_UNAVAILABLE';

export class ArtifactStorageUnavailableError extends Error {
    readonly code = ARTIFACT_STORAGE_UNAVAILABLE;

    constructor() {
        super('Artifacts require a database connection. Please ensure Prisma is configured.');
        this.name = 'ArtifactStorageUnavailableError';
    }
}

export type ArtifactFactoryFailure = {
    operation: 'cache_init' | 'background_write';
    error: unknown;
    artifactId?: string;
};

export type CreateArtifactFactoryParams = {
    tenantId: string;
    resolveCache: () =>
        | AgentResultCache
        | Promise<AgentResultCache>
        | null
        | undefined;
    onFailure?: (failure: ArtifactFactoryFailure) => void;
};

export function assertArtifactsFactory(
    artifacts: unknown
): asserts artifacts is TaskContext['artifacts'] {
    if (
        artifacts === null ||
        typeof artifacts !== 'object' ||
        typeof (artifacts as TaskContext['artifacts']).create !== 'function' ||
        typeof (artifacts as TaskContext['artifacts']).text !== 'function' ||
        typeof (artifacts as TaskContext['artifacts']).json !== 'function'
    ) {
        throw new Error('Agent context is missing a finalized artifacts factory.');
    }
}

export function createArtifactFactory(
    params: CreateArtifactFactoryParams
): TaskContext['artifacts'] {
    let cachePromise: Promise<AgentResultCache> | undefined;

    const getCache = (): Promise<AgentResultCache> => {
        if (cachePromise === undefined) {
            cachePromise = Promise.resolve()
                .then(() => params.resolveCache())
                .then((cache) => {
                    if (cache === null || cache === undefined) {
                        throw new ArtifactStorageUnavailableError();
                    }
                    return cache;
                })
                .catch((error) => {
                    params.onFailure?.({ operation: 'cache_init', error });
                    throw error;
                });
        }
        return cachePromise;
    };

    const create = <T>(
        value?: T,
        options?: { mimeType?: string; preview?: string }
    ): ArtifactHandle<T> => {
        const artifact = new ArtifactImpl<T>(
            undefined,
            getCache(),
            params.tenantId,
            options?.mimeType
        );
        if (value !== undefined) {
            void artifact.set(value).catch((error) => {
                params.onFailure?.({
                    operation: 'background_write',
                    error,
                    artifactId: artifact.id,
                });
            });
        }
        return artifact;
    };

    const artifacts: TaskContext['artifacts'] = {
        create,
        text: (value?: string) => create(value, { mimeType: 'text/plain' }),
        json: <T>(value?: T) => create(value, { mimeType: 'application/json' }),
    };
    assertArtifactsFactory(artifacts);
    return artifacts;
}
