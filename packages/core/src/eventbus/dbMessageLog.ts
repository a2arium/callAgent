import { v7 as uuidv7 } from 'uuid';
import type { SessionManager } from '../orchestration/SessionManager.js';
import type {
    MessageLog,
    MessageLogAppendParams,
    MessageLogAppendResult,
    MessageLogDelivery,
    MessageLogFindByIdempotencyParams,
    MessageLogReadParams,
    MessageLogRecord,
} from '../public-types/messageLog/types.js';
import type { ConversationMessageRecord } from '@a2arium/callagent-memory-engine';
import { MemberIdSchema, SpeechActSchema } from '../public-types/conversation/schemas.js';

function toRecord(row: ConversationMessageRecord): MessageLogRecord {
    return {
        messageId: row.messageId,
        sequenceNumber: row.sequenceNumber,
        conversationKind: row.conversationKind,
        senderAgentId: row.senderAgentId,
        senderMemberId: MemberIdSchema.parse(row.senderMemberId),
        selectorKind: row.selectorKind ?? undefined,
        selectorPolicyId: row.selectorPolicyId ?? undefined,
        speechAct: SpeechActSchema.parse(row.speechAct),
        payload: row.payload,
        correlationId: row.correlationId,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt,
    };
}

export function createDbMessageLog(sessionManager: SessionManager): MessageLog {
    return {
        async append(params: MessageLogAppendParams): Promise<MessageLogAppendResult> {
            if (params.idempotencyKey) {
                const existing = await sessionManager.findConversationMessageByIdempotencyKey({
                    tenantId: params.tenantId,
                    conversationId: params.conversationId,
                    senderMemberId: String(params.senderMemberId),
                    idempotencyKey: params.idempotencyKey,
                });
                if (existing) {
                    return {
                        kind: 'dedupeHit',
                        messageId: existing.messageId,
                        sequenceNumber: existing.sequenceNumber,
                        createdAt: existing.createdAt,
                    };
                }
            }
            const messageId = `msg-${uuidv7()}`;
            const payloadRecord: Record<string, unknown> =
                typeof params.payload === 'object' && params.payload !== null && !Array.isArray(params.payload)
                    ? (params.payload as Record<string, unknown>)
                    : { content: params.payload };
            const appended = await sessionManager.appendConversationMessage({
                tenantId: params.tenantId,
                conversationId: params.conversationId,
                messageId,
                senderAgentId: params.senderAgentId,
                senderMemberId: String(params.senderMemberId),
                recipientAgentId: params.deliveries[0]?.recipientAgentId ?? null,
                conversationKind: params.conversationKind,
                selectorKind: params.selectorKind ?? null,
                selectorPolicyId: params.selectorPolicyId ?? null,
                speechAct: params.speechAct,
                payload: payloadRecord,
                correlationId: params.correlationId,
                idempotencyKey: params.idempotencyKey,
            });
            await sessionManager.recordConversationMessageDeliveries({
                tenantId: params.tenantId,
                conversationId: params.conversationId,
                sequenceNumber: appended.sequenceNumber,
                rows: params.deliveries.map((d: MessageLogDelivery) => {
                    const status = d.status ?? 'delivered';
                    return {
                        memberId: String(d.recipientMemberId),
                        recipientAgentId: d.recipientAgentId,
                        sessionId: d.sessionId,
                        dedupeHit: false,
                        status,
                        error: d.error ?? null,
                        queuePosition: d.queuePosition ?? null,
                    };
                }),
            });
            return {
                kind: 'appended',
                messageId: appended.messageId,
                sequenceNumber: appended.sequenceNumber,
                createdAt: appended.createdAt,
            };
        },

        async read(params: MessageLogReadParams): Promise<ReadonlyArray<MessageLogRecord>> {
            const rows = await sessionManager.listConversationMessages({
                tenantId: params.tenantId,
                conversationId: params.conversationId,
                sinceSequence: params.fromSequence,
            });
            const sliced =
                params.limit !== undefined ? rows.slice(0, params.limit) : rows;
            return sliced.map(toRecord);
        },

        async *replay(params: MessageLogReadParams): AsyncIterable<MessageLogRecord> {
            const page = await this.read({ ...params, limit: params.limit ?? 500 });
            for (const r of page) {
                yield r;
            }
        },

        async findByIdempotency(
            params: MessageLogFindByIdempotencyParams
        ): Promise<MessageLogRecord | null> {
            const row = await sessionManager.findConversationMessageByIdempotencyKey({
                tenantId: params.tenantId,
                conversationId: params.conversationId,
                senderMemberId: String(params.senderMemberId),
                idempotencyKey: params.idempotencyKey,
            });
            return row ? toRecord(row) : null;
        },
    };
}
