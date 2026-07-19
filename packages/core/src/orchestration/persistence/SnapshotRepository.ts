import { isWorkingMemoryVersionConflict } from '@a2arium/callagent-types/working-memory-version-conflict';
import { logger } from '@a2arium/callagent-utils';
import { defaultMetricsRegistry } from '../../observability/metrics.js';
import { FrameworkError } from '../../utils/errors.js';
import type { SessionManager } from '../SessionManager.js';

const log = logger.createLogger({ prefix: 'SnapshotRepository' });

export type SnapshotMutationSession = {
    load: (tenantId: string, sessionId: string) => Promise<{
        snapshot?: unknown;
        wmVersion?: bigint;
        agentId?: string;
    } | null>;
    loadForMutation?: (tenantId: string, sessionId: string) => Promise<{
        snapshot?: unknown;
        wmVersion?: bigint;
        agentId?: string;
        storageNow?: string;
    } | null>;
    saveSnapshot: (params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }) => Promise<unknown>;
};

export type SnapshotMutationCurrent = {
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    agentId?: string;
    storageNow: string;
};

export type SnapshotMutationDecision<T> =
    | { kind: 'write'; snapshot: Record<string, unknown>; value: T }
    | { kind: 'noop'; value: T };

export type SnapshotMutationResult<T> = {
    status: 'committed' | 'noop';
    value: T;
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    attempts: number;
};

export type ReconcileSnapshotMutationOptions<T> = {
    session: SnapshotMutationSession;
    tenantId: string;
    sessionId: string;
    operation: string;
    agentId?: string;
    mutate: (
        current: SnapshotMutationCurrent
    ) => Promise<SnapshotMutationDecision<T>> | SnapshotMutationDecision<T>;
    maxAttempts?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
};

export type SnapshotReconciliationDetails = {
    operation: string;
    tenantId: string;
    sessionId: string;
    attempts: number;
    expectedWmVersion?: string;
    actualWmVersion?: string;
    storageCode: 'WM_VERSION_CONFLICT';
};

export class SnapshotReconciliationError extends FrameworkError {
    public readonly code = 'WM_SNAPSHOT_RECONCILIATION_EXHAUSTED';
    public readonly reconciliation: SnapshotReconciliationDetails;
    public readonly cause?: unknown;

    constructor(details: SnapshotReconciliationDetails, cause?: unknown) {
        super(
            `Working-memory snapshot reconciliation exhausted for ${details.operation} after ${details.attempts} attempts.`,
            details
        );
        this.reconciliation = details;
        this.cause = cause;
        Object.setPrototypeOf(this, SnapshotReconciliationError.prototype);
    }
}

export function isSnapshotReconciliationError(error: unknown): error is SnapshotReconciliationError {
    return error instanceof SnapshotReconciliationError || (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'WM_SNAPSHOT_RECONCILIATION_EXHAUSTED'
    );
}

function readConflictVersions(error: unknown): {
    expectedWmVersion?: string;
    actualWmVersion?: string;
} {
    if (error === null || typeof error !== 'object') return {};
    const conflict = (error as { conflict?: unknown; details?: unknown }).conflict ??
        (error as { details?: unknown }).details;
    if (conflict === null || typeof conflict !== 'object') return {};
    const fields = conflict as { expectedWmVersion?: unknown; actualWmVersion?: unknown };
    return {
        ...(typeof fields.expectedWmVersion === 'string'
            ? { expectedWmVersion: fields.expectedWmVersion }
            : {}),
        ...(typeof fields.actualWmVersion === 'string'
            ? { actualWmVersion: fields.actualWmVersion }
            : {}),
    };
}

function readSavedVersion(result: unknown, fallback: bigint): bigint {
    if (result !== null && typeof result === 'object' && 'newVersion' in result) {
        const value = (result as { newVersion?: unknown }).newVersion;
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
        if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    }
    return fallback;
}

function jitterDelay(
    attempt: number,
    baseBackoffMs: number,
    maxBackoffMs: number,
    random: () => number
): number {
    const cap = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, attempt - 1)));
    const sample = Math.max(0, Math.min(0.999999999, random()));
    return Math.floor(sample * cap);
}

/**
 * Reload and reapply one logical snapshot mutation until its CAS write commits.
 * Mutation callbacks may be invoked more than once and must therefore be replay-safe.
 */
export async function reconcileSnapshotMutation<T>(
    options: ReconcileSnapshotMutationOptions<T>
): Promise<SnapshotMutationResult<T>> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    const baseBackoffMs = Math.max(0, options.baseBackoffMs ?? 10);
    const maxBackoffMs = Math.max(baseBackoffMs, options.maxBackoffMs ?? 200);
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    const startedAt = now();
    let lastConflict: unknown;
    let versions: { expectedWmVersion?: string; actualWmVersion?: string } = {};

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const loaded = options.session.loadForMutation !== undefined
            ? await options.session.loadForMutation(options.tenantId, options.sessionId)
            : await options.session.load(options.tenantId, options.sessionId);
        const loadedStorageNow = (loaded as { storageNow?: unknown } | null)?.storageNow;
        const current: SnapshotMutationCurrent = {
            snapshot: (loaded?.snapshot as Record<string, unknown> | undefined) ?? {},
            wmVersion: loaded?.wmVersion ?? BigInt(0),
            agentId: loaded?.agentId,
            storageNow: typeof loadedStorageNow === 'string'
                ? loadedStorageNow
                : new Date(now()).toISOString(),
        };
        const decision = await options.mutate(current);
        if (decision.kind === 'noop') {
            defaultMetricsRegistry.increment('wm.snapshot_reconciliation_total', {
                operation: options.operation,
                status: 'noop',
            });
            defaultMetricsRegistry.observeDuration(
                'wm.snapshot_reconciliation_duration_ms',
                now() - startedAt,
                { operation: options.operation, status: 'noop' }
            );
            return {
                status: 'noop',
                value: decision.value,
                snapshot: current.snapshot,
                wmVersion: current.wmVersion,
                attempts: attempt,
            };
        }

        try {
            const saved = await options.session.saveSnapshot({
                tenantId: options.tenantId,
                sessionId: options.sessionId,
                agentId: options.agentId ?? (current.wmVersion === 0n ? undefined : current.agentId) ??
                    (current.snapshot as { meta?: { agentId?: string } }).meta?.agentId ??
                    'default',
                expectedWmVersion: current.wmVersion,
                snapshot: decision.snapshot,
            });
            if (saved === null) {
                throw new Error('WM_SNAPSHOT_STORE_UNAVAILABLE');
            }
            const wmVersion = readSavedVersion(saved, current.wmVersion + BigInt(1));
            defaultMetricsRegistry.increment('wm.snapshot_reconciliation_total', {
                operation: options.operation,
                status: 'committed',
            });
            defaultMetricsRegistry.observeDuration(
                'wm.snapshot_reconciliation_duration_ms',
                now() - startedAt,
                { operation: options.operation, status: 'committed' }
            );
            return {
                status: 'committed',
                value: decision.value,
                snapshot: decision.snapshot,
                wmVersion,
                attempts: attempt,
            };
        } catch (error) {
            if (!isWorkingMemoryVersionConflict(error)) throw error;
            lastConflict = error;
            versions = {
                expectedWmVersion: current.wmVersion.toString(),
                ...readConflictVersions(error),
            };
            defaultMetricsRegistry.increment('wm.snapshot_conflict_total', {
                operation: options.operation,
            });
            log.debug('Working-memory snapshot conflict; replaying mutation', {
                operation: options.operation,
                tenantId: options.tenantId,
                sessionId: options.sessionId,
                attempt,
                maxAttempts,
                ...versions,
            });
            if (attempt < maxAttempts) {
                const delayMs = jitterDelay(attempt, baseBackoffMs, maxBackoffMs, random);
                if (delayMs > 0) await sleep(delayMs);
            }
        }
    }

    const details: SnapshotReconciliationDetails = {
        operation: options.operation,
        tenantId: options.tenantId,
        sessionId: options.sessionId,
        attempts: maxAttempts,
        ...versions,
        storageCode: 'WM_VERSION_CONFLICT',
    };
    defaultMetricsRegistry.increment('wm.snapshot_reconciliation_total', {
        operation: options.operation,
        status: 'exhausted',
    });
    defaultMetricsRegistry.observeDuration(
        'wm.snapshot_reconciliation_duration_ms',
        now() - startedAt,
        { operation: options.operation, status: 'exhausted' }
    );
    log.warn('Working-memory snapshot reconciliation exhausted', details);
    throw new SnapshotReconciliationError(details, lastConflict);
}

export type MutatorFn = (
    snapshot: Record<string, unknown>
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface SaveWithRetryOptions {
    tenantId: string;
    sessionId: string;
    agentId?: string;
    operation?: string;
    mutate: MutatorFn;
    maxRetries?: number;
    backoffMs?: number;
}

export class SnapshotRepository {
    constructor(private sessionManager: SessionManager) {}

    async load(tenantId: string, sessionId: string) {
        return this.sessionManager.load(tenantId, sessionId);
    }

    async saveWithRetry(options: SaveWithRetryOptions): Promise<void> {
        await reconcileSnapshotMutation({
            session: this.sessionManager,
            tenantId: options.tenantId,
            sessionId: options.sessionId,
            operation: options.operation ?? 'snapshot.save_with_retry',
            agentId: options.agentId,
            maxAttempts: options.maxRetries,
            baseBackoffMs: options.backoffMs,
            mutate: async ({ snapshot }) => ({
                kind: 'write',
                snapshot: await options.mutate(snapshot),
                value: undefined,
            }),
        });
    }

    async appendEvent(
        tenantId: string,
        sessionId: string,
        type: string,
        payload: Record<string, unknown>
    ) {
        return this.sessionManager.appendEvent(tenantId, sessionId, type, payload);
    }

    async enqueueOutbox(
        tenantId: string,
        type: string,
        traceId: string,
        payload: Record<string, unknown>
    ): Promise<{ id: string } | void> {
        return this.sessionManager.enqueueOutbox(tenantId, type, traceId, payload);
    }
}
