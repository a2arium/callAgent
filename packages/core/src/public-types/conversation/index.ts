import { InviteTokenSchema, MemberIdSchema } from './schemas.js';
import type { InviteToken, MemberId } from './types.js';

/** Validate / brand a runtime string as topic-scoped `MemberId`. */
export function memberId(s: string): MemberId {
    return MemberIdSchema.parse(s);
}

/** Validate / brand a runtime string as invite capability `InviteToken`. */
export function inviteToken(s: string): InviteToken {
    return InviteTokenSchema.parse(s);
}

export { SignalKindSchema, type SignalKind } from './signal.js';

export {
    TopicStopPolicyContextSchema,
    TopicStopPolicyEvaluationDecisionSchema,
    type TopicStopPolicyContext,
    type TopicStopPolicyEvaluationDecision,
    type StopPolicyDefinition,
    type StopPolicyRegistry,
} from './stopPolicy.js';

export {
    MAX_TOPIC_MEMBERS,
    ConversationIdSchema,
    MessageIdSchema,
    CorrelationIdSchema,
    IdempotencyKeySchema,
    AgentIdSchema,
    MemberIdSchema,
    InviteTokenSchema,
    JsonValueSchema,
    ResolvedTopicMemberSchema,
    ThreadRefSchema,
    TopicRefSchema,
    ConversationRefSchema,
    TopicMemberRoleSchema,
    TopicMemberSchema,
    TopicSelectorSchema,
    TopicStopPolicySchema,
    SelectorPolicyFanoutTraceSchema,
    StopPolicyFanoutTraceSchema,
    ConversationErrorSchema,
    SpeechActSchema,
    OutboundThreadMessageSchema,
    OutboundTopicMessageSchema,
    InboundMessageSchema,
    SendReceiptSchema,
    DeliverySummarySchema,
    FanoutSendReceiptSchema,
    StartThreadOptionsSchema,
    SendOptionsSchema,
    CloseConversationOptionsSchema,
    TopicCreateOptionsSchema,
    TopicInviteOptionsSchema,
    TopicJoinOptionsSchema,
    TopicDeclineOptionsSchema,
    TopicLeaveOptionsSchema,
    TopicPostOptionsSchema,
    StartThreadReceiptSchema,
    TopicCreateReceiptSchema,
    TopicInviteReceiptSchema,
    TopicJoinReceiptSchema,
    TopicDeclineReceiptSchema,
    TopicLeaveReceiptSchema,
    CloseConversationReceiptSchema,
} from './schemas.js';

export type { TopicStopPolicyRule, StopPolicyFanoutTrace } from './schemas.js';

export {
    TopicSelectorPolicyContextSchema,
    TopicSelectorPolicyResultSchema,
} from './selectorPolicy.js';

export {
    ConversationProjectionSchema,
    ThreadProjectionEntrySchema,
    TopicProjectionEntrySchema,
} from './projection.js';

export type {
    JsonValue,
    ConversationId,
    MessageId,
    CorrelationId,
    IdempotencyKey,
    AgentId,
    MemberId,
    InviteToken,
    ResolvedTopicMember,
    ThreadRef,
    TopicRef,
    ConversationRef,
    ConversationError,
    TopicMember,
    TopicSelector,
    OutboundThreadMessage,
    OutboundTopicMessage,
    InboundMessage,
    SendReceipt,
    DeliverySummary,
    FanoutSendReceipt,
    StartThreadOptions,
    SendOptions,
    CloseConversationOptions,
    TopicCreateOptions,
    TopicInviteOptions,
    TopicJoinOptions,
    TopicDeclineOptions,
    TopicLeaveOptions,
    TopicPostOptions,
    StartThreadReceipt,
    TopicCreateReceipt,
    TopicInviteReceipt,
    TopicJoinReceipt,
    TopicDeclineReceipt,
    TopicLeaveReceipt,
    CloseConversationReceipt,
    ConversationProjection,
    ConversationApi,
} from './types.js';

export type {
    TopicSelectorPolicy,
    TopicSelectorPolicyContext,
    TopicSelectorPolicyResult,
} from './selectorPolicy.js';

export {
    defineTopicProjection,
    ReadProjectionOptionsSchema,
    ReadProjectionReceiptSchema,
    AppendSignalInputSchema,
    type TopicProjectionToken,
    type TopicProjectionDefinition,
    type ReadProjectionOptions,
    type ReadProjectionReceipt,
    type AppendSignalInput,
} from './topicProjection.js';
