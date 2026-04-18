import { createBusEvent } from './busEventHelpers.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type {
    MessageLog,
    MessageLogAppendParams,
    MessageLogAppendResult,
    MessageLogFindByIdempotencyParams,
    MessageLogReadParams,
    MessageLogRecord,
} from '../public-types/messageLog/types.js';

/**
 * After each successful topic append, publishes `conversation.message.appended` on `stream.<conversationId>`
 * so in-process `DurableSubscription` consumers can follow the log in real time.
 */
export function wrapMessageLogWithTopicStream(params: {
    inner: MessageLog;
    eventBus: IEventBus;
}): MessageLog {
    const { inner, eventBus } = params;

    const publishRecord = async (p: MessageLogAppendParams, sequenceNumber: number): Promise<void> => {
        const rows = await inner.read({
            tenantId: p.tenantId,
            conversationId: p.conversationId,
            fromSequence: sequenceNumber,
            limit: 1,
        });
        const record = rows[0];
        if (!record) {
            return;
        }
        await eventBus.publish(
            createBusEvent({
                channel: `stream.${p.conversationId}`,
                partitionKey: p.conversationId,
                cloud: {
                    id: record.messageId,
                    type: 'conversation.message.appended',
                    source: `/tenants/${p.tenantId}/conversations/${p.conversationId}`,
                    time: record.createdAt,
                    datacontenttype: 'application/json',
                    data: { record },
                },
            })
        );
    };

    return {
        async append(p: MessageLogAppendParams): Promise<MessageLogAppendResult> {
            const r = await inner.append(p);
            if (r.kind === 'appended' && p.conversationKind === 'topic') {
                await publishRecord(p, r.sequenceNumber);
            }
            return r;
        },
        read(params: MessageLogReadParams): Promise<ReadonlyArray<MessageLogRecord>> {
            return inner.read(params);
        },
        replay(params: MessageLogReadParams): AsyncIterable<MessageLogRecord> {
            return inner.replay(params);
        },
        findByIdempotency(params: MessageLogFindByIdempotencyParams): Promise<MessageLogRecord | null> {
            return inner.findByIdempotency(params);
        },
    };
}
