import { z } from 'zod';
import {
    ConversationIdSchema,
    JsonValueSchema,
    MemberIdSchema,
    ResolvedTopicMemberSchema,
} from './schemas.js';

export type { JsonValue } from './schemas.js';

export const TopicSelectorPolicyContextSchema = z.object({
    tenantId: z.string().min(1),
    topicId: ConversationIdSchema,
    senderMemberId: MemberIdSchema,
    members: z.array(ResolvedTopicMemberSchema).min(1),
    rotationCursor: z.string().nullable(),
    lastSpeakerMemberId: MemberIdSchema.optional(),
    sequenceNumber: z.number().int().nonnegative(),
    params: JsonValueSchema.optional(),
    nowIso: z.string().datetime(),
});
export type TopicSelectorPolicyContext = z.infer<typeof TopicSelectorPolicyContextSchema>;

export const TopicSelectorPolicyResultSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('selected'),
        recipients: z.array(ResolvedTopicMemberSchema).min(0),
        nextRotationCursor: z.string().nullable(),
    }),
    z.object({
        kind: z.literal('rejected'),
        error: z.discriminatedUnion('type', [
            z.object({ type: z.literal('PolicyParamsInvalid'), message: z.string() }),
            z.object({ type: z.literal('PolicyAbstain'), message: z.string() }),
            z.object({ type: z.literal('PolicyInternalError'), message: z.string() }),
        ]),
    }),
]);
export type TopicSelectorPolicyResult = z.infer<typeof TopicSelectorPolicyResultSchema>;

export type TopicSelectorPolicy = {
    policyId: string;
    paramsSchema?: z.ZodType<unknown>;
    select(context: TopicSelectorPolicyContext): TopicSelectorPolicyResult;
};
