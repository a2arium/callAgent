import { z } from 'zod';
import {
    AgentIdSchema,
    ConversationErrorSchema,
    ConversationRefSchema,
    DeliverySummarySchema,
    InboundMessageSchema,
    MessageIdSchema,
    MemberIdSchema,
    ThreadRefSchema,
    TopicRefSchema,
    ResolvedTopicMemberSchema,
    TopicSelectorSchema,
} from '../public-types/conversation/schemas.js';

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
    message: z.string()
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
        timestamp: z.string().optional()
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
        reason: z.string().optional(),
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
        reason: z.string().optional(),
        ts: z.string(),
    }),
    z.object({
        kind: z.literal('outbound.committed'),
        ref: ConversationRefSchema,
        messageId: MessageIdSchema,
        sequenceNumber: z.number().int().positive(),
        correlationId: z.string().min(1).optional(),
        deliveries: z.array(DeliverySummarySchema),
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

export const ObservationSchema = z.discriminatedUnion('source', [
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
    z.object({ 
        source: z.literal('internal'), 
        kind: z.enum([
            'llm.responded', 
            'plan.proposed', 
            'plan.updated', 
            'plan.step.updated',
            'goal.updated', 
            'validation.failed', 
            'state.noted'
        ]), 
        payload: z.unknown(),
        ...BaseObservationProps
    }),
    z.object({ 
        source: z.literal('env'), 
        kind: z.enum(['config.updated', 'clock.tick', 'snapshot.available', 'external.event']), 
        payload: z.unknown(),
        ...BaseObservationProps
    }),
    ConversationObservationSchema,
]);

export type Observation = z.infer<typeof ObservationSchema>;

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
