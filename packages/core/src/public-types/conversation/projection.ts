import { z } from 'zod';
import {
    AgentIdSchema,
    CloseReasonSchema,
    InviteTokenSchema,
    MemberIdSchema,
    ThreadRefSchema,
    ThreadStatusSchema,
    TopicRefSchema,
    TopicMemberRoleSchema,
    TopicSelectorSchema,
} from './schemas.js';

export const ThreadProjectionEntrySchema = z.object({
    ref: ThreadRefSchema,
    status: ThreadStatusSchema,
    lastInboundSequence: z.number().int().positive().optional(),
    lastOutboundSequence: z.number().int().positive().optional(),
    pendingOutgoing: z.boolean(),
    closedAt: z.string().datetime().optional(),
    closedReason: CloseReasonSchema.optional(),
    closedReasonText: z.string().optional(),
    closedByAgentId: AgentIdSchema.optional(),
    archivedAt: z.string().datetime().optional(),
    archivedByAgentId: AgentIdSchema.optional(),
    archivedReasonText: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
});

export const TopicProjectionEntrySchema = z.object({
    ref: TopicRefSchema,
    status: z.enum(['open', 'closed', 'archived']),
    members: z.array(
        z.object({
            agentId: z.string(),
            memberId: z.string(),
            role: z.enum(['owner', 'participant']),
        })
    ),
    lastInboundSequence: z.number().int().positive().optional(),
    lastOutboundSequence: z.number().int().positive().optional(),
    currentSelector: TopicSelectorSchema,
    pendingInvites: z
        .array(
            z.object({
                token: InviteTokenSchema,
                inviteeAgentId: AgentIdSchema,
                inviteeMemberId: MemberIdSchema.optional(),
                role: TopicMemberRoleSchema,
                expiresAt: z.string().datetime(),
            })
        )
        .optional(),
});

export const ConversationProjectionSchema = z.object({
    threads: z.record(z.string(), ThreadProjectionEntrySchema),
    topics: z.record(z.string(), TopicProjectionEntrySchema),
    invitesInbox: z
        .array(
            z.object({
                topic: TopicRefSchema,
                token: InviteTokenSchema,
                inviterAgentId: AgentIdSchema,
                role: TopicMemberRoleSchema,
                inviteeMemberId: MemberIdSchema.optional(),
                expiresAt: z.string().datetime(),
            })
        )
        .optional(),
});

export type ConversationProjection = z.infer<typeof ConversationProjectionSchema>;
