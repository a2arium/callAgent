import { AgentResultCache, offloadArtifacts } from '@a2arium/callagent-memory-engine';
import type { ObservationInbox } from '../loop/types.js';
import { makeSafeEventPreview } from './safeEventPreview.js';

const CHILD_RESULT_INLINE_STRING_MAX_CHARS = 64 * 1024;
const CHILD_RESULT_PERSISTENCE_DEPTH_LIMIT = 20;

export class ArtifactPersistenceError extends Error {
    public readonly code = 'ARTIFACT_PERSISTENCE_FAILED';
    public readonly cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'ArtifactPersistenceError';
        this.cause = options?.cause;
        Object.setPrototypeOf(this, ArtifactPersistenceError.prototype);
    }
}

export function isArtifactPersistenceError(error: unknown): error is ArtifactPersistenceError {
    return error instanceof ArtifactPersistenceError || (
        !!error &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === 'ARTIFACT_PERSISTENCE_FAILED'
    );
}

type ChildResultPersistenceContext = {
    cache: AgentResultCache | undefined;
    tenantId: string;
    visited: WeakMap<object, unknown>;
    localArtifacts: WeakMap<object, Promise<Record<string, unknown>>>;
};

function inferChildResultArtifactMimeType(value: string): string {
    return value.trimStart().startsWith('<') ? 'text/html' : 'text/plain';
}

function canonicalArtifactMarker(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'artifact') return undefined;

    let serialized: unknown = value;
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
        serialized = toJSON.call(value);
    }
    if (!serialized || typeof serialized !== 'object') return undefined;
    const marker = serialized as Record<string, unknown>;
    if (marker.kind !== 'artifact' || typeof marker.id !== 'string') return undefined;

    return {
        kind: 'artifact',
        id: marker.id,
        ...(typeof marker.mimeType === 'string' ? { mimeType: marker.mimeType } : {}),
        ...(typeof marker.estimatedSize === 'number' && Number.isFinite(marker.estimatedSize)
            ? { estimatedSize: marker.estimatedSize }
            : {}),
    };
}

async function offloadLocalArtifact(
    value: object,
    context: ChildResultPersistenceContext
): Promise<Record<string, unknown>> {
    const existing = context.localArtifacts.get(value);
    if (existing) return existing;

    const upload = (async () => {
        try {
            const prepared = await offloadArtifacts(value, context.cache!, context.tenantId);
            const marker = canonicalArtifactMarker(prepared);
            if (!marker) {
                throw new ArtifactPersistenceError(
                    'Artifact storage did not return a durable artifact marker.'
                );
            }
            return marker;
        } catch (error) {
            if (isArtifactPersistenceError(error)) throw error;
            throw new ArtifactPersistenceError('Failed to persist artifact content.', { cause: error });
        }
    })();
    context.localArtifacts.set(value, upload);
    return upload;
}

async function prepareChildResultForPersistenceInternal(
    value: unknown,
    depth: number,
    context: ChildResultPersistenceContext
): Promise<unknown> {
    if (typeof value === 'string') {
        if (value.length <= CHILD_RESULT_INLINE_STRING_MAX_CHARS) {
            return value;
        }
        if (context.cache) {
            const local = {
                kind: 'artifact_local',
                value,
                mimeType: inferChildResultArtifactMimeType(value),
            };
            return offloadLocalArtifact(local, context);
        }
        return makeSafeEventPreview(value);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
        return makeSafeEventPreview(value);
    }
    if (depth >= CHILD_RESULT_PERSISTENCE_DEPTH_LIMIT) {
        return makeSafeEventPreview(value);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const record = value as Record<string, unknown>;
    if (record.kind === 'artifact') {
        const marker = canonicalArtifactMarker(value);
        if (!marker) {
            throw new ArtifactPersistenceError('Artifact handle did not provide a valid durable marker.');
        }
        return marker;
    }
    if (record.kind === 'artifact_local') {
        if (context.cache) {
            return offloadLocalArtifact(value as object, context);
        }
        return makeSafeEventPreview(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (context.visited.has(value as object)) {
        return context.visited.get(value as object);
    }

    if (Array.isArray(value)) {
        const output: unknown[] = [];
        context.visited.set(value, output);
        for (const item of value) {
            output.push(await prepareChildResultForPersistenceInternal(item, depth + 1, context));
        }
        return output;
    }

    const output: Record<string, unknown> = {};
    context.visited.set(value as object, output);
    for (const [key, item] of Object.entries(record)) {
        output[key] = await prepareChildResultForPersistenceInternal(item, depth + 1, context);
    }
    return output;
}

export async function prepareChildResultForPersistence(
    value: unknown,
    cache: AgentResultCache | undefined,
    tenantId: string,
    depth = 0,
    visited = new WeakMap<object, unknown>()
): Promise<unknown> {
    return prepareChildResultForPersistenceInternal(value, depth, {
        cache,
        tenantId,
        visited,
        localArtifacts: new WeakMap<object, Promise<Record<string, unknown>>>(),
    });
}

export async function prepareChildResultsInInboxForPersistence(
    inbox: ObservationInbox,
    cache: AgentResultCache | undefined,
    tenantId: string
): Promise<ObservationInbox> {
    return prepareChildResultForPersistence(inbox, cache, tenantId) as Promise<ObservationInbox>;
}
