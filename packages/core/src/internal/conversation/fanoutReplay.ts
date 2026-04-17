import type { ConversationMessageDeliveryRecord, ConversationMessageRecord } from '@a2arium/callagent-memory-engine';
import { ConversationErrorSchema, MemberIdSchema } from '../../public-types/conversation/schemas.js';
import type { ConversationError } from '../../public-types/conversation/types.js';
import type { DeliverySummary, FanoutSendReceipt, MemberId, TopicRef } from '../../public-types/conversation/types.js';

function errorFromStored(raw: Record<string, unknown> | null): ConversationError {
    if (!raw) {
        return { type: 'Unsupported', message: 'Missing delivery error payload.' };
    }
    const parsed = ConversationErrorSchema.safeParse(raw);
    return parsed.success ? parsed.data : { type: 'Unsupported', message: 'Invalid stored delivery error.' };
}

/**
 * Reconstructs the original `FanoutSendReceipt` from persisted message + delivery rows (idempotent replay).
 */
export function reconstructFanoutReceiptFromDeliveries(
    topic: TopicRef,
    message: ConversationMessageRecord,
    deliveries: ConversationMessageDeliveryRecord[]
): FanoutSendReceipt {
    if (deliveries.length === 0) {
        return {
            status: 'accepted',
            topic,
            deliveries: [],
        };
    }

    const summaries: DeliverySummary[] = deliveries.map((d) => ({
        memberId: MemberIdSchema.parse(d.memberId),
        recipientAgentId: d.recipientAgentId,
        sessionId: d.sessionId,
        messageId: message.messageId,
        sequenceNumber: message.sequenceNumber,
        dedupeHit: true,
        correlationId: message.correlationId,
    }));

    const delivered = deliveries.filter((d) => d.status === 'delivered');
    const rejectedRows = deliveries.filter((d) => d.status === 'rejected');
    const queuedRows = deliveries.filter((d) => d.status === 'queued');

    const allDelivered = delivered.length === deliveries.length;
    if (allDelivered) {
        return { status: 'accepted', topic, deliveries: summaries };
    }

    const anyDelivered = delivered.length > 0;
    const anyFailed = rejectedRows.length > 0 || queuedRows.length > 0;

    if (anyDelivered && anyFailed) {
        const acceptedSummaries = summaries.filter((_, i) => deliveries[i]!.status === 'delivered');
        const rejectedOut: Array<{ memberId: MemberId; recipientAgentId: string; error: ConversationError }> = [];
        for (let i = 0; i < deliveries.length; i++) {
            const d = deliveries[i]!;
            if (d.status === 'delivered') {
                continue;
            }
            rejectedOut.push({
                memberId: MemberIdSchema.parse(d.memberId),
                recipientAgentId: d.recipientAgentId,
                error:
                    d.status === 'queued'
                        ? { type: 'ThreadBusy', message: 'Recipient session busy (queued).' }
                        : errorFromStored(d.error),
            });
        }
        return {
            status: 'partial',
            topic,
            accepted: acceptedSummaries,
            rejected: rejectedOut,
        };
    }

    if (!anyDelivered && queuedRows.length === deliveries.length) {
        const qp = queuedRows[0]?.queuePosition ?? 0;
        return { status: 'queued', topic, queuePosition: qp };
    }

    if (!anyDelivered && rejectedRows.length === deliveries.length) {
        return {
            status: 'rejected',
            topic,
            error: errorFromStored(rejectedRows[0]!.error),
        };
    }

    return {
        status: 'rejected',
        topic,
        error: errorFromStored(deliveries[0]!.error),
    };
}
