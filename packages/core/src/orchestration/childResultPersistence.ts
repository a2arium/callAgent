import { AgentResultCache, offloadArtifacts } from '@a2arium/callagent-memory-engine';
import type { ObservationInbox } from '../loop/types.js';
import { makeSafeEventPreview } from './safeEventPreview.js';

const CHILD_RESULT_INLINE_STRING_MAX_CHARS = 64 * 1024;
const CHILD_RESULT_PERSISTENCE_DEPTH_LIMIT = 20;

function inferChildResultArtifactMimeType(value: string): string {
    return value.trimStart().startsWith('<') ? 'text/html' : 'text/plain';
}

async function offloadChildResultValueAsArtifact(
    value: unknown,
    cache: AgentResultCache,
    tenantId: string,
    mimeType?: string
): Promise<unknown> {
    return offloadArtifacts(
        {
            kind: 'artifact_local',
            value,
            ...(mimeType ? { mimeType } : {}),
        },
        cache,
        tenantId
    );
}

export async function prepareChildResultForPersistence(
    value: unknown,
    cache: AgentResultCache | undefined,
    tenantId: string,
    depth = 0,
    visited = new WeakMap<object, unknown>()
): Promise<unknown> {
    if (typeof value === 'string') {
        if (value.length <= CHILD_RESULT_INLINE_STRING_MAX_CHARS) {
            return value;
        }
        if (cache) {
            return offloadChildResultValueAsArtifact(
                value,
                cache,
                tenantId,
                inferChildResultArtifactMimeType(value)
            );
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
        return value;
    }
    if (record.kind === 'artifact_local') {
        if (cache) {
            return offloadArtifacts(value, cache, tenantId);
        }
        return makeSafeEventPreview(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (visited.has(value as object)) {
        return visited.get(value as object);
    }

    if (Array.isArray(value)) {
        const output: unknown[] = [];
        visited.set(value, output);
        for (const item of value) {
            output.push(await prepareChildResultForPersistence(item, cache, tenantId, depth + 1, visited));
        }
        return output;
    }

    const output: Record<string, unknown> = {};
    visited.set(value as object, output);
    for (const [key, item] of Object.entries(record)) {
        output[key] = await prepareChildResultForPersistence(item, cache, tenantId, depth + 1, visited);
    }
    return output;
}

function isChildCompletedObservation(value: unknown): value is Record<string, unknown> & {
    payload: Record<string, unknown>;
} {
    return !!value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).kind === 'child.completed' &&
        !!(value as { payload?: unknown }).payload &&
        typeof (value as { payload?: unknown }).payload === 'object';
}

async function prepareChildObservationForPersistence(
    observation: unknown,
    cache: AgentResultCache | undefined,
    tenantId: string
): Promise<unknown> {
    if (!isChildCompletedObservation(observation)) {
        return observation;
    }

    const payload = observation.payload;
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
        return observation;
    }

    const preparedResult = await prepareChildResultForPersistence(payload.result, cache, tenantId);
    if (preparedResult === payload.result) {
        return observation;
    }

    return {
        ...observation,
        payload: {
            ...payload,
            result: preparedResult,
        },
    };
}

export async function prepareChildResultsInInboxForPersistence(
    inbox: ObservationInbox,
    cache: AgentResultCache | undefined,
    tenantId: string
): Promise<ObservationInbox> {
    const current = await Promise.all(
        (inbox.current ?? []).map((observation) =>
            prepareChildObservationForPersistence(observation, cache, tenantId)
        )
    );
    const all = await Promise.all(
        (inbox.all ?? []).map((observation) =>
            prepareChildObservationForPersistence(observation, cache, tenantId)
        )
    );

    return {
        ...inbox,
        current: current as ObservationInbox['current'],
        all: all as ObservationInbox['all'],
    };
}
