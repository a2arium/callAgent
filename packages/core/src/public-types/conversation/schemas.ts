import { z } from 'zod';

import { SignalKindSchema } from './signal.js';

export const MAX_TOPIC_MEMBERS = 64;

export const ConversationIdSchema = z.string().min(1);
export const MessageIdSchema = z.string().min(1);
export const CorrelationIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1);
export const AgentIdSchema = z.string().min(1);
export const MemberIdSchema = z.string().min(1).brand<'MemberId'>();
export const InviteTokenSchema = z.string().min(1).brand<'InviteToken'>();

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonValue =
    | z.infer<typeof JsonPrimitiveSchema>
    | { [key: string]: JsonValue }
    | JsonValue[];
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);

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

/** Thread row status (public single source of truth). */
export const ThreadStatusSchema = z.enum(['open', 'closed', 'archived']);

/**
 * Why a thread entered the `closed` state in policy/projection (not necessarily 1:1 with DB `close_reason`).
 * @remarks `closedAt` and `closedReason` are both present once a thread is no longer `open` (reducer invariant).
 */
export const CloseReasonSchema = z.enum(['explicit', 'ttl', 'archived']);

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
    z.object({
        kind: z.literal('selector_policy'),
        policyId: z.string().min(1).max(120),
        params: JsonValueSchema.optional(),
    }),
]);

export const ConversationErrorSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('ThreadBusy'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('NoEligibleRecipients'),
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
        type: z.literal('ConversationNotFound'),
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
        type: z.literal('InviteNotFound'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('InviteExpired'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('InviteAlreadyConsumed'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('InviteTargetMismatch'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('TopicCapacityExceeded'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('SelectorPolicyNotRegistered'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('PolicyParamsInvalid'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('PolicyInternalError'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('StopPolicyNotRegistered'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('StopPolicyParamsInvalid'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('StopPolicyInternalError'),
        message: z.string(),
        policyId: z.string().optional(),
    }),
    z.object({
        type: z.literal('ConversationNotClosed'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ThreadExpired'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ConversationTimeout'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('ProjectionNotRegistered'),
        message: z.string(),
        projectionName: z.string().optional(),
    }),
    z.object({
        type: z.literal('ProjectionStateInvalid'),
        message: z.string(),
        projectionName: z.string().optional(),
    }),
    z.object({
        type: z.literal('InvalidSignalKind'),
        message: z.string(),
    }),
    z.object({
        type: z.literal('RecipientNotThreadable'),
        message: z.string(),
        agentId: z.string().optional(),
    }),
    z.object({
        type: z.literal('SpeechActNotAccepted'),
        message: z.string(),
        speechAct: z.string().optional(),
    }),
    z.object({
        type: z.literal('ContentTypeNotAccepted'),
        message: z.string(),
        contentType: z.string().optional(),
    }),
    z.object({
        type: z.literal('JsonSchemaValidationFailed'),
        message: z.string(),
    }),
]);

export const SpeechActSchema = z.enum([
    'question',
    'answer',
    'inform',
    'request',
    'task',
    'followup',
    'signal',
    'vote',
    'system',
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
    senderMemberId: MemberIdSchema,
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

export const SelectorPolicyFanoutTraceSchema = z.object({
    policyId: z.string(),
    result: z.enum([
        'selected',
        'abstained_fallback_broadcast',
        'params_invalid',
        'not_registered',
        'internal_error',
    ]),
    paramsHash: z.string().optional(),
});

/** Outcome of topic stop-policy evaluation after a successful topic append (for receipts / TurnTrace). Omitted when policies are not evaluated or all rules continue. */
export const StopPolicyFanoutTraceSchema = z.discriminatedUnion('result', [
    z.object({ result: z.literal('stop'), reason: z.string().optional() }),
    z.object({
        result: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);
export type StopPolicyFanoutTrace = z.infer<typeof StopPolicyFanoutTraceSchema>;

export const FanoutSendReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('accepted'),
        topic: TopicRefSchema,
        deliveries: z.array(DeliverySummarySchema),
        selectorPolicyTrace: SelectorPolicyFanoutTraceSchema.optional(),
        stopPolicyTrace: StopPolicyFanoutTraceSchema.optional(),
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
        selectorPolicyTrace: SelectorPolicyFanoutTraceSchema.optional(),
        stopPolicyTrace: StopPolicyFanoutTraceSchema.optional(),
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
    /**
     * @remarks Ignored at runtime when `awaitMode` is `'deferred'` (default); only bounds blocking `startThread` when `awaitMode === 'blocking'`.
     */
    timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
    awaitMode: z.enum(['blocking', 'deferred']).optional(),
    /**
     * @remarks When `true`, the framework persists and routes the message but does **not** run cold activation on the recipient.
     * Used only by `sendTaskToAgent` orchestration so `A2AService` runs the child once; agents must not set this from policy.
     */
    skipRecipientActivation: z.boolean().optional(),
});

export const SendOptionsSchema = z.object({
    idempotencyKey: IdempotencyKeySchema.optional(),
    queueMode: z.enum(['queue', 'reject']).optional(),
    timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
    /**
     * @remarks Default `deferred`. When `blocking`, the caller waits (up to `timeoutMs` if set) for a `message.received` on the sender session with the same `correlationId` as the outbound message.
     */
    awaitMode: z.enum(['blocking', 'deferred']).optional(),
    /**
     * @remarks Same semantics as `StartThreadOptions.skipRecipientActivation`; internal orchestration only.
     */
    skipRecipientActivation: z.boolean().optional(),
});

/**
 * @remarks `archiveAfter: true` closes then archives in one orchestration path for both `thread` and `topic` refs.
 */
export const CloseConversationOptionsSchema = z.object({
    reason: z.string().min(1).max(500).optional(),
    archiveAfter: z.boolean().optional(),
});

export const ArchiveConversationOptionsSchema = z.object({
    reasonText: z.string().min(1).max(500).optional(),
});

export const TopicStopPolicySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('maxTurns'),
        n: z.number().int().positive().max(10_000),
    }),
    z.object({
        kind: z.literal('maxRounds'),
        n: z.number().int().positive().max(10_000),
    }),
    z.object({
        kind: z.literal('timeout'),
        afterMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000),
    }),
    z.object({
        kind: z.literal('signalBased'),
        signals: z.array(SignalKindSchema).min(1),
        requiredCount: z.number().int().positive().optional(),
    }),
    z.object({
        kind: z.literal('custom'),
        policyId: z.string().min(1).max(120),
        params: JsonValueSchema.optional(),
    }),
]);

export type TopicStopPolicyRule = z.infer<typeof TopicStopPolicySchema>;

export const TopicCreateOptionsSchema = z.object({
    topicId: ConversationIdSchema.optional(),
    members: z.array(TopicMemberSchema).min(1),
    defaultSelector: TopicSelectorSchema.optional(),
    /**
     * At least one stop rule; evaluated in order after each successful topic append.
     */
    stopPolicies: z.array(TopicStopPolicySchema).min(1),
    idempotencyKey: IdempotencyKeySchema.optional(),
});

export const TopicInviteOptionsSchema = z.object({
    topic: TopicRefSchema,
    invitee: TopicMemberSchema,
    ttlSeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    correlationId: z.string().max(256).optional(),
});

export const TopicJoinOptionsSchema = z.object({
    inviteToken: InviteTokenSchema,
});

export const TopicDeclineOptionsSchema = z.object({
    inviteToken: InviteTokenSchema,
    reason: z.string().max(500).optional(),
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
    /** Present when `awaitMode === 'blocking'` and the wait exceeded `timeoutMs`. */
    timedOut: z.boolean().optional(),
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
        token: InviteTokenSchema,
        expiresAt: z.string().datetime(),
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

export const TopicDeclineReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        topic: TopicRefSchema,
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

export const CloseConversationReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        ref: ConversationRefSchema,
        closed: z.boolean(),
        archived: z.boolean().optional(),
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export const ArchiveConversationReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        ref: ConversationRefSchema,
        archived: z.boolean(),
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);
