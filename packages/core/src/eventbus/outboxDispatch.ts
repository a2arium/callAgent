import { logger } from '@a2arium/callagent-utils';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createBusEvent } from './busEventHelpers.js';
import { taskChannel } from './taskEventEmitter.js';

const log = logger.createLogger({ prefix: 'OutboxDispatch' });

export type OutboxRow = {
    id: string;
    tenantId: string;
    topic: string;
    key: string;
    payload: unknown;
    createdAt: Date;
    retryCount: number;
};

type OutboxPrisma = {
    outbox: {
        delete: (args: { where: { id: string } }) => Promise<unknown>;
        update: (args: {
            where: { id: string };
            data: { retryCount: number };
        }) => Promise<unknown>;
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
}): Promise<void> {
    const { prisma, row, error, maxRetries } = params;
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to dispatch outbox row', error as { message?: string }, {
        id: row.id,
        topic: row.topic,
    });
    const nextRetry = (row.retryCount ?? 0) + 1;
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
        } catch (dlqErr) {
            log.error('Dead-letter insert failed', dlqErr as { message?: string }, { id: row.id });
        }
        await prisma.outbox.delete({ where: { id: row.id } }).catch(() => undefined);
        return;
    }
    await prisma.outbox
        .update({
            where: { id: row.id },
            data: { retryCount: nextRetry },
        })
        .catch(() => undefined);
}
