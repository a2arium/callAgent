import { z } from 'zod';

export const MAX_TOPIC_MEMBERS = 64;

export const ConversationIdSchema = z.string().min(1);
export const MessageIdSchema = z.string().min(1);
export const CorrelationIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1);
export const AgentIdSchema = z.string().min(1);
export const MemberIdSchema = z.string().min(1).brand<'MemberId'>();

export const ThreadRefSchema = z.object({
    kind: z.literal('thread'),
    id: ConversationIdSchema,
});

export const TopicRefSchema = z.object({
    kind: z.literal('topic'),
    id: ConversationIdSchema,
});

export const ConversationRefSchema = z.discriminatedUnion('kind', [ThreadRefSchema, TopicRefSchema]);

export const TopicMemberRoleSchema = z.enum(['owner', 'participant']);

export const TopicMemberSchema = z.object({
    agentId: AgentIdSchema,
    memberId: MemberIdSchema.optional(),
    role: TopicMemberRoleSchema,
    sessionIdOverride: z.string().min(1).optional(),
});

export const ResolvedTopicMemberSchema = z.object({
    agentId: AgentIdSchema,
    memberId: MemberIdSchema,
    role: TopicMemberRoleSchema,
    sessionId: z.string().min(1),
});

export const TopicSelectorSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('broadcast') }),
    z.object({ kind: z.literal('round_robin') }),
    z.object({
        kind: z.literal('explicit_recipient'),
        recipient: z.discriminatedUnion('by', [
            z.object({ by: z.literal('agentId'), agentId: AgentIdSchema }),
            z.object({ by: z.literal('memberId'), memberId: MemberIdSchema }),
        ]),
    }),
]);

export const ConversationErrorSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('ThreadBusy'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ConversationClosed'),
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
    z.object({
        type: z.literal('TopicNotFound'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('NotAMember'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('AlreadyMember'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('SelectorUnsupported'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('RecipientNotMember'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('RecipientAmbiguous'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('SenderAmbiguous'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('RecipientNotResolvable'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('InviteRequired'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('InviteInvalid'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('TopicCapacityExceeded'),
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

export const OutboundTopicMessageSchema = z.object({
    senderAgentId: AgentIdSchema,
    senderMemberId: MemberIdSchema.optional(),
    speechAct: SpeechActSchema,
    content: z.unknown(),
    correlationId: CorrelationIdSchema.optional(),
});

export const InboundMessageSchema = z.object({
    id: MessageIdSchema,
    conversation: ConversationRefSchema,
    senderAgentId: AgentIdSchema,
    recipientAgentId: AgentIdSchema,
    recipientMemberId: MemberIdSchema,
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

export const DeliverySummarySchema = z.object({
    memberId: MemberIdSchema,
    recipientAgentId: AgentIdSchema,
    sessionId: z.string().min(1),
    messageId: MessageIdSchema,
    sequenceNumber: z.number().int().positive(),
    dedupeHit: z.boolean(),
    correlationId: CorrelationIdSchema.optional(),
});

export const FanoutSendReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('accepted'),
        topic: TopicRefSchema,
        deliveries: z.array(DeliverySummarySchema),
    }),
    z.object({
        status: z.literal('partial'),
        topic: TopicRefSchema,
        accepted: z.array(DeliverySummarySchema),
        rejected: z.array(
            z.object({
                memberId: MemberIdSchema,
                recipientAgentId: AgentIdSchema,
                error: ConversationErrorSchema,
            })
        ),
    }),
    z.object({
        status: z.literal('queued'),
        topic: TopicRefSchema,
        queuePosition: z.number().int().nonnegative(),
    }),
    z.object({
        status: z.literal('rejected'),
        topic: TopicRefSchema,
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

export const TopicCreateOptionsSchema = z.object({
    topicId: ConversationIdSchema.optional(),
    members: z.array(TopicMemberSchema).min(1),
    defaultSelector: TopicSelectorSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
});

export const TopicInviteOptionsSchema = z.object({
    topic: TopicRefSchema,
    invitee: TopicMemberSchema,
});

export const TopicJoinOptionsSchema = z.object({
    inviteToken: z.string().min(1),
});

export const TopicLeaveOptionsSchema = z.object({
    memberId: MemberIdSchema.optional(),
});

export const TopicPostOptionsSchema = z.object({
    selector: TopicSelectorSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    queueMode: z.enum(['queue', 'reject']).optional(),
});

export const StartThreadReceiptSchema = z.object({
    thread: ThreadRefSchema,
    receipt: SendReceiptSchema,
});

export const TopicCreateReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        topic: TopicRefSchema,
        members: z.array(ResolvedTopicMemberSchema),
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export const TopicInviteReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        token: z.string().min(1),
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export const TopicJoinReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        topic: TopicRefSchema,
        member: ResolvedTopicMemberSchema,
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export const TopicLeaveReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        topic: TopicRefSchema,
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export const CloseConversationReceiptSchema = z.object({
    ref: ConversationRefSchema,
    closed: z.boolean(),
});
