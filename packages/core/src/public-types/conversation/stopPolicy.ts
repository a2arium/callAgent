import { z } from 'zod';

import {
    ConversationIdSchema,
    JsonValueSchema,
    MemberIdSchema,
    ResolvedTopicMemberSchema,
} from './schemas.js';

export const TopicStopPolicyContextSchema = z.object({
    tenantId: z.string().min(1),
    topicId: ConversationIdSchema,
    /** Topic row `createdAt` (ISO). Used by built-in `timeout`. */
    topicCreatedAtIso: z.string().datetime(),
    nowIso: z.string().datetime(),
    sequenceNumber: z.number().int().nonnegative(),
    totalMessages: z.number().int().nonnegative(),
    /** Complete member-rounds: `floor(totalMessages / max(1, memberCount))`. */
    totalRounds: z.number().int().nonnegative(),
    lastMessage: z
        .object({
            senderMemberId: MemberIdSchema,
            speechAct: z.string().min(1),
            sequenceNumber: z.number().int().nonnegative(),
        })
        .optional(),
    members: z.array(ResolvedTopicMemberSchema).min(1),
    params: JsonValueSchema.optional(),
});
export type TopicStopPolicyContext = z.infer<typeof TopicStopPolicyContextSchema>;

export const TopicStopPolicyEvaluationDecisionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('continue') }),
    z.object({
        kind: z.literal('stop'),
        reason: z.string().min(1).max(500).optional(),
    }),
    z.object({
        kind: z.literal('rejected'),
        error: z.discriminatedUnion('type', [
            z.object({ type: z.literal('PolicyParamsInvalid'), message: z.string() }),
            z.object({ type: z.literal('PolicyInternalError'), message: z.string() }),
        ]),
    }),
]);
export type TopicStopPolicyEvaluationDecision = z.infer<typeof TopicStopPolicyEvaluationDecisionSchema>;

/** Registered `custom` stop policy implementation (serializable id + pure `evaluate`). */
export type StopPolicyDefinition = {
    policyId: string;
    paramsSchema?: z.ZodType<unknown>;
    evaluate(context: TopicStopPolicyContext): TopicStopPolicyEvaluationDecision;
};

export type StopPolicyRegistry = {
    register(policy: StopPolicyDefinition): void;
    resolve(policyId: string): StopPolicyDefinition | undefined;
    list(): ReadonlyArray<string>;
};
