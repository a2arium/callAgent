import { z } from 'zod';
import {
    AgentIdSchema,
    ConversationIdSchema,
    CorrelationIdSchema,
    IdempotencyKeySchema,
    MemberIdSchema,
    MessageIdSchema,
    SpeechActSchema,
} from '../conversation/schemas.js';

export const ConversationKindSchema = z.enum(['thread', 'topic']);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const MessageLogDeliverySchema = z.object({
    recipientAgentId: AgentIdSchema,
    recipientMemberId: MemberIdSchema,
    sessionId: z.string().min(1),
    /**
     * @remarks Defaults to `delivered` when omitted. Conversation routing can set `buffered` before recipient snapshot commit,
     * then promote to `delivered` or `dead-lettered`.
     */
    status: z
        .enum([
            'delivered',
            'rejected',
            'queued',
            'buffered',
            'throttled',
            'paused',
            'dead-lettered',
        ])
        .optional(),
    error: z.record(z.string(), z.unknown()).nullable().optional(),
    queuePosition: z.number().int().nonnegative().nullable().optional(),
});
export type MessageLogDelivery = z.infer<typeof MessageLogDeliverySchema>;

export const MessageLogAppendParamsSchema = z.object({
    tenantId: z.string().min(1),
    conversationId: ConversationIdSchema,
    conversationKind: ConversationKindSchema,
    senderAgentId: AgentIdSchema,
    senderMemberId: MemberIdSchema,
    selectorKind: z.string().optional(),
    /** Present when `selectorKind === 'selector_policy'`. */
    selectorPolicyId: z.string().min(1).max(120).optional(),
    speechAct: SpeechActSchema,
    payload: z.unknown(),
    correlationId: CorrelationIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    deliveries: z.array(MessageLogDeliverySchema).min(1),
});
export type MessageLogAppendParams = z.infer<typeof MessageLogAppendParamsSchema>;

export const MessageLogAppendResultSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('appended'),
        messageId: MessageIdSchema,
        sequenceNumber: z.number().int().nonnegative(),
        createdAt: z.string().datetime(),
    }),
    z.object({
        kind: z.literal('dedupeHit'),
        messageId: MessageIdSchema,
        sequenceNumber: z.number().int().nonnegative(),
        createdAt: z.string().datetime(),
    }),
]);
export type MessageLogAppendResult = z.infer<typeof MessageLogAppendResultSchema>;

export const MessageLogReadParamsSchema = z.object({
    tenantId: z.string().min(1),
    conversationId: ConversationIdSchema,
    fromSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).optional(),
});
export type MessageLogReadParams = z.infer<typeof MessageLogReadParamsSchema>;

export const MessageLogRecordSchema = z.object({
    messageId: MessageIdSchema,
    sequenceNumber: z.number().int().nonnegative(),
    conversationKind: ConversationKindSchema,
    senderAgentId: AgentIdSchema,
    senderMemberId: MemberIdSchema,
    selectorKind: z.string().optional(),
    selectorPolicyId: z.string().min(1).max(120).optional(),
    speechAct: SpeechActSchema,
    payload: z.unknown(),
    correlationId: CorrelationIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    createdAt: z.string().datetime(),
});
export type MessageLogRecord = z.infer<typeof MessageLogRecordSchema>;

export const MessageLogFindByIdempotencyParamsSchema = z.object({
    tenantId: z.string().min(1),
    conversationId: ConversationIdSchema,
    senderMemberId: MemberIdSchema,
    idempotencyKey: IdempotencyKeySchema,
});
export type MessageLogFindByIdempotencyParams = z.infer<
    typeof MessageLogFindByIdempotencyParamsSchema
>;
