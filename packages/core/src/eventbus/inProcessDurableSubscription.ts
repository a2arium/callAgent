import type { BusEvent } from '../public-types/eventbus/schemas.js';
import { MessageLogRecordSchema } from '../public-types/messageLog/schemas.js';
import type { MessageLog, MessageLogRecord } from '../public-types/messageLog/types.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type { DurableSubscription, DurableSubscriptionHandler } from '../public-types/messageLog/durableSubscription.types.js';
import type {
    DurableSubscriptionAckParams,
    DurableSubscriptionCursor,
    DurableSubscriptionNackParams,
} from '../public-types/messageLog/durableSubscription.schemas.js';
import { busEventData } from './busEventHelpers.js';

export type DurableSubscriptionPersistence = {
    getDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
    }): Promise<{ sequenceNumber: number; updatedAt: string } | null>;
    upsertDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
        sequenceNumber: number;
        updatedAt: string;
    }): Promise<void>;
    appendConversationDeadLetter(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        consumerId: string;
        record: Record<string, unknown>;
        lastError: string;
        attempts: number;
        deadletteredAt: string;
    }): Promise<void>;
};

async function* readAllSequences(
    messageLog: MessageLog,
    base: { tenantId: string; conversationId: string },
    startSequence: number
): AsyncIterable<MessageLogRecord> {
    let from = startSequence;
    for (;;) {
        const page = await messageLog.read({
            tenantId: base.tenantId,
            conversationId: base.conversationId,
            fromSequence: from,
            limit: 500,
        });
        if (page.length === 0) {
            return;
        }
        for (const r of page) {
            yield r;
        }
        from = page[page.length - 1]!.sequenceNumber + 1;
    }
}

type StreamPayload = { record?: MessageLogRecord };

function recordFromBusEvent(ev: BusEvent): MessageLogRecord | null {
    if (ev.payload.type !== 'conversation.message.appended') {
        return null;
    }
    const data = busEventData<StreamPayload>(ev);
    const raw = data?.record;
    if (!raw) {
        return null;
    }
    const parsed = MessageLogRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

type InProcessDurableSubscriptionDeps = {
    tenantId: string;
    messageLog: MessageLog;
    eventBus: IEventBus;
    persistence: DurableSubscriptionPersistence;
    maxHandlerRetries?: number;
    nowIso?: () => string;
};

export function createInProcessDurableSubscription(deps: InProcessDurableSubscriptionDeps): DurableSubscription {
    const maxHandlerRetries = deps.maxHandlerRetries ?? 5;
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());

    const deliverToHandler = async (
        handler: DurableSubscriptionHandler,
        ev: { streamId: string; consumerId: string; record: MessageLogRecord; deliveryAttempt: number }
    ): Promise<'ack' | 'nack'> => {
        const decision = await handler({
            streamId: ev.streamId,
            consumerId: ev.consumerId,
            record: ev.record,
            deliveryAttempt: ev.deliveryAttempt,
        });
        if (decision === 'ack') {
            return 'ack';
        }
        return 'nack';
    };

    const impl: DurableSubscription = {
        async subscribe(params: {
            streamId: string;
            consumerId: string;
            handler: DurableSubscriptionHandler;
            startFrom?: 'earliest' | 'cursor' | { sequenceNumber: number };
        }): Promise<{ unsubscribe: () => Promise<void> }> {
            const { streamId, consumerId, handler } = params;
            const tenantId = deps.tenantId;
            const persisted = await deps.persistence.getDurableSubscriptionCursor({
                tenantId,
                streamId,
                consumerId,
            });
            const cursorSeq = persisted?.sequenceNumber;

            let replayStart: number;
            if (params.startFrom === 'earliest') {
                replayStart = 0;
            } else if (params.startFrom && typeof params.startFrom === 'object') {
                replayStart = params.startFrom.sequenceNumber;
            } else if (params.startFrom === 'cursor' || params.startFrom === undefined) {
                replayStart = cursorSeq !== undefined ? cursorSeq + 1 : 0;
            } else {
                replayStart = cursorSeq !== undefined ? cursorSeq + 1 : 0;
            }

            let highWater = cursorSeq ?? -1;

            for await (const record of readAllSequences(deps.messageLog, { tenantId, conversationId: streamId }, replayStart)) {
                let attempt = 0;
                let done = false;
                while (!done && attempt < maxHandlerRetries) {
                    attempt += 1;
                    const res = await deliverToHandler(handler, {
                        streamId,
                        consumerId,
                        record,
                        deliveryAttempt: attempt,
                    });
                    if (res === 'ack') {
                        highWater = Math.max(highWater, record.sequenceNumber);
                        await deps.persistence.upsertDurableSubscriptionCursor({
                            tenantId,
                            streamId,
                            consumerId,
                            sequenceNumber: record.sequenceNumber,
                            updatedAt: nowIso(),
                        });
                        done = true;
                    }
                }
                if (!done) {
                    await deps.persistence.appendConversationDeadLetter({
                        tenantId,
                        conversationId: streamId,
                        sequenceNumber: record.sequenceNumber,
                        consumerId,
                        record: record as unknown as Record<string, unknown>,
                        lastError: 'handler retries exhausted',
                        attempts: maxHandlerRetries,
                        deadletteredAt: nowIso(),
                    });
                }
            }

            const busSub = await deps.eventBus.subscribe(`stream.${streamId}`, async (busEvent) => {
                const record = recordFromBusEvent(busEvent);
                if (!record || record.sequenceNumber <= highWater) {
                    return;
                }
                let attempt = 0;
                let ok = false;
                while (!ok && attempt < maxHandlerRetries) {
                    attempt += 1;
                    const res = await deliverToHandler(handler, {
                        streamId,
                        consumerId,
                        record,
                        deliveryAttempt: attempt,
                    });
                    if (res === 'ack') {
                        highWater = Math.max(highWater, record.sequenceNumber);
                        await deps.persistence.upsertDurableSubscriptionCursor({
                            tenantId,
                            streamId,
                            consumerId,
                            sequenceNumber: record.sequenceNumber,
                            updatedAt: nowIso(),
                        });
                        ok = true;
                    }
                }
                if (!ok) {
                    await deps.persistence.appendConversationDeadLetter({
                        tenantId,
                        conversationId: streamId,
                        sequenceNumber: record.sequenceNumber,
                        consumerId,
                        record: record as unknown as Record<string, unknown>,
                        lastError: 'handler retries exhausted (live)',
                        attempts: maxHandlerRetries,
                        deadletteredAt: nowIso(),
                    });
                }
            });

            return {
                unsubscribe: async () => {
                    await busSub.unsubscribe();
                },
            };
        },

        async ack(params: DurableSubscriptionAckParams): Promise<void> {
            await deps.persistence.upsertDurableSubscriptionCursor({
                tenantId: deps.tenantId,
                streamId: params.streamId,
                consumerId: params.consumerId,
                sequenceNumber: params.sequenceNumber,
                updatedAt: nowIso(),
            });
        },

        async nack(params: DurableSubscriptionNackParams): Promise<void> {
            await deps.persistence.appendConversationDeadLetter({
                tenantId: deps.tenantId,
                conversationId: params.streamId,
                sequenceNumber: params.sequenceNumber,
                consumerId: params.consumerId,
                record: {
                    messageId: params.messageId,
                    nackReason: params.reason,
                    retryAfterMs: params.retryAfterMs,
                },
                lastError: params.reason,
                attempts: 1,
                deadletteredAt: nowIso(),
            });
        },

        async getCursor(p: { streamId: string; consumerId: string }): Promise<DurableSubscriptionCursor | null> {
            const row = await deps.persistence.getDurableSubscriptionCursor({
                tenantId: deps.tenantId,
                streamId: p.streamId,
                consumerId: p.consumerId,
            });
            if (!row) {
                return null;
            }
            return {
                streamId: p.streamId,
                consumerId: p.consumerId,
                sequenceNumber: row.sequenceNumber,
                updatedAt: row.updatedAt,
            };
        },

        async setCursor(cursor: DurableSubscriptionCursor): Promise<void> {
            await deps.persistence.upsertDurableSubscriptionCursor({
                tenantId: deps.tenantId,
                streamId: cursor.streamId,
                consumerId: cursor.consumerId,
                sequenceNumber: cursor.sequenceNumber,
                updatedAt: cursor.updatedAt,
            });
        },
    };

    return impl;
}

/**
 * Alias for {@link createInProcessDurableSubscription}: NATS JetStream bundles use the same
 * in-process coordinator with broker-backed `MessageLog` and `IEventBus` (5.4c).
 */
export function createNatsJetStreamDurableSubscription(deps: InProcessDurableSubscriptionDeps): DurableSubscription {
    return createInProcessDurableSubscription(deps);
}
