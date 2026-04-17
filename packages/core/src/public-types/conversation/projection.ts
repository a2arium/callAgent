import { z } from 'zod';
import { ThreadRefSchema, TopicRefSchema, TopicSelectorSchema } from './schemas.js';

export const ThreadProjectionEntrySchema = z.object({
    ref: ThreadRefSchema,
    status: z.enum(['open', 'closed', 'archived']),
    lastInboundSequence: z.number().int().positive().optional(),
    lastOutboundSequence: z.number().int().positive().optional(),
    pendingOutgoing: z.boolean(),
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
});

export const ConversationProjectionSchema = z.object({
    threads: z.record(z.string(), ThreadProjectionEntrySchema),
    topics: z.record(z.string(), TopicProjectionEntrySchema),
});

export type ConversationProjection = z.infer<typeof ConversationProjectionSchema>;
