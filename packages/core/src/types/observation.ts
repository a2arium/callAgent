import { z } from 'zod';
import {
    AgentIdSchema,
    CloseReasonSchema,
    CorrelationIdSchema,
    ConversationErrorSchema,
    ConversationRefSchema,
    DeliverySummarySchema,
    InboundMessageSchema,
    InviteTokenSchema,
    MessageIdSchema,
    MemberIdSchema,
    SpeechActSchema,
    TopicMemberRoleSchema,
    ThreadRefSchema,
    TopicRefSchema,
    ResolvedTopicMemberSchema,
    TopicSelectorSchema,
} from '../public-types/conversation/schemas.js';
import { PlanSchema, PlanStepUpdatedPayloadSchema } from './plan.js';
import { PlanPatchPayloadSchema } from '../plans/planPatch.js';

export const ObservationProvenanceSchema = z.object({
    ts: z.number(),
    turn: z.number(),
    id: z.string().optional(),
    toolId: z.string().optional(),
    correlationId: z.string().optional()
});

export type ObservationProvenance = z.infer<typeof ObservationProvenanceSchema>;

export const ExecErrorPayloadSchema = z.object({
    code: z.string(),
    message: z.string(),
    timeoutMs: z.number().nonnegative().optional()
});

export type ExecErrorPayload = z.infer<typeof ExecErrorPayloadSchema>;

export const UserEnvelopeSchema = z.object({
    token: z.string(),
    value: z.unknown()
});

export type UserEnvelope = z.infer<typeof UserEnvelopeSchema>;

export const ToolEnvelopeSchema = z.object({
    token: z.string(),
    tool: z.string(),
    result: z.unknown().optional(),
    error: ExecErrorPayloadSchema.optional()
});

export type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

export const ChildEnvelopeSchema = z.object({
    token: z.string(),
    agentId: z.string().optional(),
    childTaskId: z.string().optional(),
    result: z.unknown().optional(),
    error: ExecErrorPayloadSchema.optional(),
    executionMetadata: z.object({
        timings: z.unknown().optional(),
        rewards: z.unknown().optional(),
        state: z.string().optional(),
        timestamp: z.string().optional(),
        origin: z.enum(['cache', 'runtime']).optional()
    }).optional()
});

export type ChildEnvelope = z.infer<typeof ChildEnvelopeSchema>;

// Shared properties for all observation types
const BaseObservationProps = {
    provenance: ObservationProvenanceSchema.optional(),
    error: ExecErrorPayloadSchema.optional()
};

/** Single source of truth: payload.kind drives the event type. */
export const ConversationPayloadSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('message.received'),
        message: InboundMessageSchema,
    }),
    z.object({
        kind: z.literal('delivery.failed'),
        thread: ThreadRefSchema,
        error: ConversationErrorSchema,
        messageId: MessageIdSchema.optional(),
        recipientAgentId: AgentIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('thread.closed'),
        thread: ThreadRefSchema,
        ts: z.string().datetime(),
        closedBy: AgentIdSchema.optional(),
        closedReason: CloseReasonSchema.optional(),
        reasonText: z.string().min(1).max(500).optional(),
    }),
    z.object({
        kind: z.literal('thread.archived'),
        thread: ThreadRefSchema,
        ts: z.string().datetime(),
        archivedBy: AgentIdSchema.optional(),
        archivedByMemberId: MemberIdSchema.optional(),
        reasonText: z.string().min(1).max(500).optional(),
    }),
    z.object({
        kind: z.literal('topic.message.received'),
        message: InboundMessageSchema,
        topic: TopicRefSchema,
        selector: TopicSelectorSchema,
        recipient: z.object({
            memberId: MemberIdSchema,
            agentId: AgentIdSchema,
        }),
    }),
    z.object({
        kind: z.literal('topic.invite.issued'),
        topic: TopicRefSchema,
        invitee: z.object({
            agentId: AgentIdSchema,
            memberId: MemberIdSchema.optional(),
            role: TopicMemberRoleSchema,
        }),
        token: InviteTokenSchema,
        expiresAt: z.string().datetime(),
        inviterAgentId: AgentIdSchema,
        ts: z.string().datetime(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.invite.received'),
        topic: TopicRefSchema,
        token: InviteTokenSchema,
        expiresAt: z.string().datetime(),
        role: TopicMemberRoleSchema,
        inviterAgentId: AgentIdSchema,
        inviteeMemberId: MemberIdSchema.optional(),
        ts: z.string().datetime(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.invite.accepted'),
        topic: TopicRefSchema,
        token: InviteTokenSchema,
        member: ResolvedTopicMemberSchema,
        ts: z.string().datetime(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.invite.declined'),
        topic: TopicRefSchema,
        token: InviteTokenSchema,
        inviteeAgentId: AgentIdSchema,
        inviteeMemberId: MemberIdSchema.optional(),
        reason: z.string().max(500).optional(),
        ts: z.string().datetime(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.invite.expired'),
        topic: TopicRefSchema,
        token: InviteTokenSchema,
        inviteeAgentId: AgentIdSchema,
        inviteeMemberId: MemberIdSchema.optional(),
        expiresAt: z.string().datetime(),
        ts: z.string().datetime(),
        correlationId: CorrelationIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.member.joined'),
        topic: TopicRefSchema,
        member: ResolvedTopicMemberSchema,
        ts: z.string(),
    }),
    z.object({
        kind: z.literal('topic.member.left'),
        topic: TopicRefSchema,
        agentId: AgentIdSchema,
        memberId: MemberIdSchema,
        reason: z.string().optional(),
        ts: z.string(),
    }),
    z.object({
        kind: z.literal('topic.closed'),
        topic: TopicRefSchema,
        ts: z.string().datetime(),
        reason: z.string().optional(),
        closedBy: AgentIdSchema.optional(),
        closedReason: CloseReasonSchema.optional(),
        reasonText: z.string().min(1).max(500).optional(),
        closedByMemberId: MemberIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('topic.archived'),
        topic: TopicRefSchema,
        ts: z.string().datetime(),
        archivedBy: AgentIdSchema.optional(),
        archivedByMemberId: MemberIdSchema.optional(),
        reasonText: z.string().min(1).max(500).optional(),
    }),
    z.object({
        kind: z.literal('topic.stopPolicy.rejected'),
        topic: TopicRefSchema,
        ts: z.string().datetime(),
        error: ConversationErrorSchema,
    }),
    z.object({
        kind: z.literal('topic.policy.unsupported'),
        topic: TopicRefSchema,
        ts: z.string().datetime(),
        unsupported: z.array(
            z.object({
                agentId: AgentIdSchema,
                missing: z.array(z.string().min(1)),
            })
        ),
    }),
    z.object({
        kind: z.literal('outbound.committed'),
        ref: ConversationRefSchema,
        messageId: MessageIdSchema,
        sequenceNumber: z.number().int().positive(),
        correlationId: z.string().min(1).optional(),
        deliveries: z.array(DeliverySummarySchema),
        /**
         * @remarks Present on thread sends when TTL is enabled: idle-reset `expires_at` after append.
         */
        threadExpiresAt: z.string().datetime().optional(),
        selectorKind: z
            .enum(['broadcast', 'round_robin', 'explicit_recipient', 'selector_policy'])
            .optional(),
        selectorPolicyId: z.string().min(1).max(120).optional(),
        selectorParamsHash: z.string().min(1).optional(),
        /** Present on topic posts: drives `topicProjections` fold in Learning. */
        topicAppend: z
            .object({
                speechAct: SpeechActSchema,
                payload: z.unknown(),
            })
            .optional(),
    }),
]);

export type ConversationPayload = z.infer<typeof ConversationPayloadSchema>;

export const ConversationObservationSchema = z
    .object({
        source: z.literal('conversation'),
        payload: ConversationPayloadSchema,
        ...BaseObservationProps,
    })
    .transform((o) => ({
        source: 'conversation' as const,
        kind: o.payload.kind,
        payload: o.payload,
        provenance: o.provenance,
        error: o.error,
    }));

export type ConversationObservation = z.infer<typeof ConversationObservationSchema>;

export const LLMRespondedPayloadSchema = z.object({
    model: z.string().optional(),
    contentSummary: z.string().optional(),
    hasStructuredOutput: z.boolean().optional(),
    schemaName: z.string().optional(),
    tokenCount: z.number().optional(),
});

export type LLMRespondedPayload = z.infer<typeof LLMRespondedPayloadSchema>;

export const ValidationFailedPayloadSchema = z.object({
    reason: z.string(),
    schemaName: z.string().optional(),
    error: ExecErrorPayloadSchema.optional(),
    zodError: z.unknown().optional(),
    originalPayload: z.unknown().optional(),
});

export type ValidationFailedPayload = z.infer<typeof ValidationFailedPayloadSchema>;

const InternalObservationSchema = z.discriminatedUnion('kind', [
    z.object({
        source: z.literal('internal'),
        kind: z.literal('plan.proposed'),
        payload: PlanSchema,
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('plan.updated'),
        payload: PlanSchema,
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('plan.step.updated'),
        payload: PlanStepUpdatedPayloadSchema,
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('plan.patch'),
        payload: PlanPatchPayloadSchema,
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('llm.responded'),
        payload: z.unknown(),
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('goal.updated'),
        payload: z.unknown(),
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('validation.failed'),
        payload: ValidationFailedPayloadSchema,
        ...BaseObservationProps,
    }),
    z.object({
        source: z.literal('internal'),
        kind: z.literal('state.noted'),
        payload: z.unknown(),
        ...BaseObservationProps,
    }),
]);

export const ObservationSchema = z.union([
    z.object({
        source: z.literal('user'),
        kind: z.enum(['input.provided', 'input.cancelled']),
        payload: UserEnvelopeSchema,
        ...BaseObservationProps
    }),
    z.object({
        source: z.literal('tool'),
        kind: z.enum(['tool.completed', 'tool.failed', 'tool.progress']),
        payload: ToolEnvelopeSchema,
        ...BaseObservationProps
    }),
    z.object({
        source: z.literal('child'),
        kind: z.enum(['child.completed', 'child.failed', 'child.progress']),
        payload: ChildEnvelopeSchema,
        ...BaseObservationProps
    }),
    InternalObservationSchema,
    z.object({
        source: z.literal('env'),
        kind: z.enum(['config.updated', 'clock.tick', 'snapshot.available', 'external.event', 'timer.expired']),
        payload: z.unknown(),
        ...BaseObservationProps
    }),
    ConversationObservationSchema,
]);

export type Observation = z.infer<typeof ObservationSchema>;
