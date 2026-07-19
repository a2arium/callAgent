import { AsyncLocalStorage } from 'node:async_hooks';
import type { TaskTurnClaim } from '../orchestration/TaskTurnCoordinator.js';

const DEFAULT_MAX_PROCESSED_KEYS = 512;

type SnapshotMeta = Record<string, unknown> & {
    processedKeys?: unknown;
};

type SnapshotWithMeta = Record<string, unknown> & {
    meta?: SnapshotMeta;
};

type ActiveSegmentContext = {
    idempotencyKey: string;
    outboxSeq: number;
    turnClaim?: TaskTurnClaim & { tenantId: string; taskId: string; abortSignal?: AbortSignal };
};

const activeSegmentContext = new AsyncLocalStorage<ActiveSegmentContext>();

export function currentSegmentIdempotencyKey(): string | undefined {
    return activeSegmentContext.getStore()?.idempotencyKey;
}

export function currentTaskTurnClaim(): ActiveSegmentContext['turnClaim'] {
    return activeSegmentContext.getStore()?.turnClaim;
}

export async function runWithSegmentIdempotencyKey<T>(
    idempotencyKey: string,
    fn: () => Promise<T>,
    turnClaim?: ActiveSegmentContext['turnClaim']
): Promise<T> {
    return activeSegmentContext.run({ idempotencyKey, outboxSeq: 0, turnClaim }, fn);
}

export function nextSegmentOutboxIdempotencyKey(topic: string): string | undefined {
    const context = activeSegmentContext.getStore();
    if (context === undefined) {
        return undefined;
    }
    context.outboxSeq += 1;
    return `${context.idempotencyKey}:outbox:${topic}:${context.outboxSeq}`;
}

export function segmentEffectIdempotencyKey(effect: string, stableId: string): string | undefined {
    const context = activeSegmentContext.getStore();
    if (context === undefined) {
        return undefined;
    }
    return `${context.idempotencyKey}:${effect}:${stableId}`;
}

export function snapshotHasProcessedSegmentKey(
    snapshot: Record<string, unknown> | undefined,
    key: string
): boolean {
    if (snapshot === undefined) {
        return false;
    }
    return readProcessedSegmentKeys(snapshot).includes(key);
}

export function addProcessedSegmentKey(
    snapshot: Record<string, unknown>,
    key: string,
    maxKeys = DEFAULT_MAX_PROCESSED_KEYS
): Record<string, unknown> {
    const typed = snapshot as SnapshotWithMeta;
    const meta = typed.meta ?? {};
    const keys = [...readProcessedSegmentKeys(snapshot), key];
    const uniqueKeys = [...new Set(keys)];
    const prunedKeys = uniqueKeys.slice(Math.max(0, uniqueKeys.length - maxKeys));

    return {
        ...snapshot,
        meta: {
            ...meta,
            processedKeys: prunedKeys,
        },
    };
}

export function readProcessedSegmentKeys(snapshot: Record<string, unknown>): string[] {
    const processedKeys = (snapshot as SnapshotWithMeta).meta?.processedKeys;
    if (!Array.isArray(processedKeys)) {
        return [];
    }
    return processedKeys.filter((key): key is string => typeof key === 'string');
}
