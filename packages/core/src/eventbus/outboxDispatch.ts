import { logger } from '@a2arium/callagent-utils';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createBusEvent } from './busEventHelpers.js';
import { taskChannel } from './taskEventEmitter.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';

const log = logger.createLogger({ prefix: 'OutboxDispatch' });

export type OutboxRow = {
    id: string;
    tenantId: string;
    topic: string;
    key: string;
    payload: unknown;
    createdAt: Date;
    retryCount: number;
    deliveryScope?: string | null;
    deliveryOwnerId?: string | null;
    dispatchLeaseId?: string | null;
    dispatchLeaseUntil?: Date | null;
};

export type OutboxClaimDisposition = 'claimed' | 'missing' | 'busy' | 'foreign_owner';

export type ClaimedOutboxRow = {
    disposition: OutboxClaimDisposition;
    row?: OutboxRow;
};

type OutboxPrisma = {
    outbox: {
        findUnique: (args: { where: { id: string } }) => Promise<OutboxRow | null>;
        delete: (args: { where: { id: string } }) => Promise<unknown>;
        deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
        update: (args: {
            where: { id: string };
            data: { retryCount: number };
        }) => Promise<unknown>;
        updateMany: (args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<{ count: number }>;
    };
    conversationDeadLetter: {
        create: (args: {
            data: {
                tenantId: string;
                conversationId: string;
                sequenceNumber: number;
                consumerId: string;
                record: object;
                lastError: string;
                attempts: number;
                deadletteredAt: Date;
            };
        }) => Promise<unknown>;
    };
};

type ClaimOutboxPrisma = Pick<OutboxPrisma, 'outbox'> & {
    $queryRawUnsafe?: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
};

export async function readOutboxStorageNow(prisma: ClaimOutboxPrisma): Promise<Date> {
    if (typeof prisma.$queryRawUnsafe !== 'function') return new Date();
    const rows = await prisma.$queryRawUnsafe<Array<{ storageNowMs: bigint | number | string }>>(
        'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "storageNowMs"'
    );
    const raw = rows[0]?.storageNowMs;
    if (raw === undefined) throw new Error('OUTBOX_STORAGE_TIME_UNAVAILABLE');
    const epochMs = Number(raw);
    if (!Number.isFinite(epochMs)) throw new Error('OUTBOX_STORAGE_TIME_INVALID');
    const offsetMs = Date.now() - epochMs;
    defaultMetricsRegistry.setGauge('runtime.storage_clock_offset_ms', offsetMs, {
        surface: 'outbox',
    });
    return new Date(epochMs);
}

/**
 * Atomically leases one outbox row. Process rows are visible only to their
 * producing runtime; shared workers may claim shared rows and legacy rows
 * whose scope is null.
 */
export async function claimOutboxRow(params: {
    prisma: ClaimOutboxPrisma;
    id: string;
    leaseId: string;
    leaseMs?: number;
    scope: 'process' | 'shared';
    ownerId?: string;
}): Promise<ClaimedOutboxRow> {
    const { prisma, id, leaseId, scope, ownerId } = params;
    if (scope === 'process' && !ownerId) {
        throw new Error('OUTBOX_PROCESS_OWNER_REQUIRED');
    }
    const leaseMs = params.leaseMs ?? 30_000;
    if (typeof prisma.$queryRawUnsafe === 'function') {
        const processScope = scope === 'process';
        const rows = await prisma.$queryRawUnsafe<Array<{
            id: string;
            storageNowMs: bigint | number | string;
        }>>(
            `WITH candidate AS (
                SELECT "id"
                FROM "outbox"
                WHERE "id" = $1
                  AND ${processScope
                      ? '"delivery_scope" = \'process\' AND "delivery_owner_id" = $4'
                      : '("delivery_scope" = \'shared\' OR "delivery_scope" IS NULL)'}
                  AND ("dispatch_lease_until" IS NULL OR "dispatch_lease_until" <= clock_timestamp())
                FOR UPDATE SKIP LOCKED
            )
            UPDATE "outbox" AS target
            SET "dispatch_lease_id" = $2,
                "dispatch_lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond')
            FROM candidate
            WHERE target."id" = candidate."id"
            RETURNING target."id",
                floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "storageNowMs"`,
            id,
            leaseId,
            leaseMs,
            ...(processScope ? [ownerId] : []),
        );
        const claimedId = rows[0]?.id;
        if (claimedId) {
            const epochMs = Number(rows[0]?.storageNowMs);
            if (Number.isFinite(epochMs)) {
                defaultMetricsRegistry.setGauge('runtime.storage_clock_offset_ms', Date.now() - epochMs, {
                    surface: 'outbox',
                });
            }
            const row = await prisma.outbox.findUnique({ where: { id: claimedId } });
            return row ? { disposition: 'claimed', row } : { disposition: 'missing' };
        }
        const existing = await prisma.outbox.findUnique({ where: { id } });
        if (!existing) return { disposition: 'missing' };
        if (
            scope === 'process' &&
            (existing.deliveryScope !== 'process' || existing.deliveryOwnerId !== ownerId)
        ) {
            return { disposition: 'foreign_owner' };
        }
        if (scope === 'shared' && existing.deliveryScope === 'process') {
            return { disposition: 'foreign_owner' };
        }
        return { disposition: 'busy' };
    }

    const now = await readOutboxStorageNow(prisma);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const scopePredicate = scope === 'process'
        ? { deliveryScope: 'process', deliveryOwnerId: ownerId }
        : { OR: [{ deliveryScope: 'shared' }, { deliveryScope: null }] };
    const claimed = await prisma.outbox.updateMany({
        where: {
            id,
            ...scopePredicate,
            OR: scope === 'process'
                ? [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lte: now } }]
                : [
                    {
                        AND: [
                            { OR: [{ deliveryScope: 'shared' }, { deliveryScope: null }] },
                            { OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lte: now } }] },
                        ],
                    },
                ],
        },
        data: { dispatchLeaseId: leaseId, dispatchLeaseUntil: leaseUntil },
    });
    if (claimed.count === 1) {
        const row = await prisma.outbox.findUnique({ where: { id } });
        return row ? { disposition: 'claimed', row } : { disposition: 'missing' };
    }
    const existing = await prisma.outbox.findUnique({ where: { id } });
    if (!existing) return { disposition: 'missing' };
    if (
        scope === 'process' &&
        (existing.deliveryScope !== 'process' || existing.deliveryOwnerId !== ownerId)
    ) {
        return { disposition: 'foreign_owner' };
    }
    if (scope === 'shared' && existing.deliveryScope === 'process') {
        return { disposition: 'foreign_owner' };
    }
    return { disposition: 'busy' };
}

export async function deleteClaimedOutboxRow(params: {
    prisma: ClaimOutboxPrisma;
    id: string;
    leaseId: string;
}): Promise<boolean> {
    const result = await params.prisma.outbox.deleteMany({
        where: { id: params.id, dispatchLeaseId: params.leaseId },
    });
    return result.count === 1;
}

export async function releaseClaimedOutboxRow(params: {
    prisma: ClaimOutboxPrisma;
    id: string;
    leaseId: string;
    retryCount?: number;
}): Promise<boolean> {
    const result = await params.prisma.outbox.updateMany({
        where: { id: params.id, dispatchLeaseId: params.leaseId },
        data: {
            dispatchLeaseId: null,
            dispatchLeaseUntil: null,
            ...(params.retryCount !== undefined ? { retryCount: params.retryCount } : {}),
        },
    });
    return result.count === 1;
}

const DEFAULT_HATCHET_TOPICS = [
    'task.status',
    'task.input_required',
    'task.child_dispatch',
] as const;

/** Hatchet task-level retries for `aplret.outbox.dispatch` (must match driver-hatchet). */
export const HATCHET_OUTBOX_DISPATCH_RETRIES = 3;

export type OutboxDispatchContext = {
    traceId?: string;
    agentId?: string;
    token?: string;
};

/** Parse W3C traceparent (`00-{traceId}-{spanId}-flags`) into trace id. */
export function parseTraceIdFromTraceparent(traceparent: unknown): string | undefined {
    if (typeof traceparent !== 'string' || traceparent.length === 0) {
        return undefined;
    }
    const parts = traceparent.split('-');
    if (parts.length < 4 || parts[0] !== '00') {
        return undefined;
    }
    const traceId = parts[1];
    return traceId && traceId.length > 0 ? traceId : undefined;
}

/** Resolve observability fields for outbox dispatch from payload + optional override. */
export function resolveOutboxDispatchContext(
    payload: Record<string, unknown>,
    override?: OutboxDispatchContext
): OutboxDispatchContext {
    const traceId =
        override?.traceId ??
        (typeof payload.traceId === 'string' ? payload.traceId : undefined) ??
        parseTraceIdFromTraceparent(payload.traceparent);
    const token =
        override?.token ?? (typeof payload.token === 'string' ? payload.token : undefined);
    const agentId =
        override?.agentId ?? (typeof payload.agentId === 'string' ? payload.agentId : undefined);
    return { traceId, agentId, token };
}

export function outboxChannel(row: { topic: string; key: string }): string {
    if (
        row.topic === 'task.status' ||
        row.topic === 'task.input_required' ||
        row.topic === 'task.child_dispatch'
    ) {
        return taskChannel(row.key);
    }
    if (row.topic.startsWith('conversation.')) {
        return row.topic;
    }
    return row.topic;
}

export function getOutboxDispatcherMode(): 'hatchet' | 'poll' {
    const mode = process.env.CALLAGENT_OUTBOX_DISPATCHER?.toLowerCase();
    return mode === 'hatchet' ? 'hatchet' : 'poll';
}

export function getHatchetOutboxTopics(): Set<string> {
    const raw = process.env.CALLAGENT_OUTBOX_HATCHET_TOPICS;
    const topics = raw
        ? raw.split(',').map((t) => t.trim()).filter(Boolean)
        : [...DEFAULT_HATCHET_TOPICS];
    return new Set(topics);
}

export function isHatchetOutboxTopic(topic: string): boolean {
    if (getOutboxDispatcherMode() !== 'hatchet') {
        return false;
    }
    return getHatchetOutboxTopics().has(topic);
}

export function shouldPollerSkipOutboxRow(row: { topic: string }): boolean {
    return isHatchetOutboxTopic(row.topic);
}

export async function dispatchOutboxRow(params: {
    eventBus: IEventBus;
    row: OutboxRow;
}): Promise<void> {
    const { eventBus, row } = params;
    const channel = outboxChannel(row);
    defaultMetricsRegistry.increment('runtime.outbox_dispatch_total', {
        status: 'attempted',
        type: row.topic,
    });
    await eventBus.publish(
        createBusEvent({
            channel,
            partitionKey: row.key,
            cloud: {
                id: row.id,
                type: row.topic,
                source: `/tenants/${row.tenantId}/tasks/${row.key}`,
                time: row.createdAt.toISOString(),
                datacontenttype: 'application/json',
                data: row.payload,
            },
        })
    );
    defaultMetricsRegistry.increment('runtime.outbox_dispatch_total', {
        status: 'completed',
        type: row.topic,
    });
}

export async function deleteOutboxRow(params: {
    prisma: { outbox: { delete: (args: { where: { id: string } }) => Promise<unknown> } };
    id: string;
}): Promise<void> {
    await params.prisma.outbox.delete({ where: { id: params.id } }).catch((deleteError: unknown) => {
        const err = deleteError as { code?: string; message?: string };
        if (err.code === 'P2025' || err.message?.includes('No record was found')) {
            log.debug('Outbox record already deleted by another process', { id: params.id });
            return;
        }
        throw deleteError;
    });
}

export async function handleOutboxDispatchFailure(params: {
    prisma: OutboxPrisma;
    row: OutboxRow;
    error: unknown;
    maxRetries: number;
    leaseId?: string;
}): Promise<void> {
    const { prisma, row, error, maxRetries } = params;
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to dispatch outbox row', error as { message?: string }, {
        id: row.id,
        topic: row.topic,
    });
    const nextRetry = (row.retryCount ?? 0) + 1;
    defaultMetricsRegistry.increment('runtime.outbox_dispatch_total', {
        status: 'failed',
        type: row.topic,
        errorCode: error instanceof Error ? error.name : 'Error',
    });
    if (nextRetry >= maxRetries) {
        try {
            await prisma.conversationDeadLetter.create({
                data: {
                    tenantId: row.tenantId,
                    conversationId: `outbox:${row.topic}`,
                    sequenceNumber: 0,
                    consumerId: row.id,
                    record: row.payload as object,
                    lastError: msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg,
                    attempts: nextRetry,
                    deadletteredAt: new Date(),
                },
            });
            defaultMetricsRegistry.increment('runtime.dead_letter_total', {
                surface: 'outbox',
                type: row.topic,
            });
        } catch (dlqErr) {
            defaultMetricsRegistry.increment('runtime.dead_letter_total', {
                surface: 'outbox',
                type: row.topic,
                status: 'failed',
                errorCode: dlqErr instanceof Error ? dlqErr.name : 'Error',
            });
            log.error('Dead-letter insert failed', dlqErr as { message?: string }, { id: row.id });
        }
        if (params.leaseId) {
            await deleteClaimedOutboxRow({ prisma, id: row.id, leaseId: params.leaseId }).catch(() => false);
        } else {
            await prisma.outbox.delete({ where: { id: row.id } }).catch(() => undefined);
        }
        return;
    }
    defaultMetricsRegistry.increment('runtime.retry_total', {
        operation: 'effect.outbox.dispatch',
        type: row.topic,
    });
    if (params.leaseId) {
        await releaseClaimedOutboxRow({
            prisma,
            id: row.id,
            leaseId: params.leaseId,
            retryCount: nextRetry,
        }).catch(() => false);
    } else {
        await prisma.outbox
            .update({
                where: { id: row.id },
                data: { retryCount: nextRetry },
            })
            .catch(() => undefined);
    }
}
