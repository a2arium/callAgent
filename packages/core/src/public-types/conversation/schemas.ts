import { z } from 'zod';

export const ConversationIdSchema = z.string().min(1);
export const MessageIdSchema = z.string().min(1);
export const CorrelationIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1);
export const AgentIdSchema = z.string().min(1);

export const ThreadRefSchema = z.object({
    kind: z.literal('thread'),
    id: ConversationIdSchema,
});

export const ConversationRefSchema = ThreadRefSchema;

export const ConversationErrorSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('ThreadBusy'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ThreadClosed'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('QueueFull'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('Forbidden'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('Unsupported'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('NotFound'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('PluginMissing'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ActivationFailed'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('RunTurnFailed'),
        message: z.string(),
    }),
]);

export const SpeechActSchema = z.enum([
    'question',
    'answer',
    'inform',
    'request',
]);

export const OutboundThreadMessageSchema = z.object({
    senderAgentId: AgentIdSchema,
    recipientAgentId: AgentIdSchema,
    speechAct: SpeechActSchema,
    content: z.unknown(),
    correlationId: CorrelationIdSchema.optional(),
});

export const InboundMessageSchema = z.object({
    id: MessageIdSchema,
    conversation: ThreadRefSchema,
    senderAgentId: AgentIdSchema,
    recipientAgentId: AgentIdSchema,
    speechAct: SpeechActSchema,
    content: z.unknown(),
    sequenceNumber: z.number().int().positive(),
    correlationId: CorrelationIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    ts: z.string(),
});

export const SendReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('accepted'),
        thread: ThreadRefSchema,
        messageId: MessageIdSchema,
        sequenceNumber: z.number().int().positive(),
        dedupeHit: z.boolean(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        status: z.literal('queued'),
        thread: ThreadRefSchema,
        queuePosition: z.number().int().nonnegative(),
    }),
    z.object({
        status: z.literal('rejected'),
        thread: ThreadRefSchema,
        error: ConversationErrorSchema,
    }),
]);

export const StartThreadOptionsSchema = z.object({
    targetAgentId: AgentIdSchema,
    message: OutboundThreadMessageSchema.omit({ recipientAgentId: true }).extend({
        recipientAgentId: AgentIdSchema.optional(),
    }),
    conversationId: ConversationIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    queueMode: z.enum(['queue', 'reject']).optional(),
});

export const SendOptionsSchema = z.object({
    idempotencyKey: IdempotencyKeySchema.optional(),
    queueMode: z.enum(['queue', 'reject']).optional(),
});

export const CloseConversationOptionsSchema = z.object({
    reason: z.string().optional(),
});

export const StartThreadReceiptSchema = z.object({
    thread: ThreadRefSchema,
    receipt: SendReceiptSchema,
});

export const CloseConversationReceiptSchema = z.object({
    thread: ThreadRefSchema,
    closed: z.boolean(),
});

