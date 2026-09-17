import type { z } from 'zod';
import type {
    ArchiveConversationOptionsSchema,
    ArchiveConversationReceiptSchema,
    CloseConversationOptionsSchema,
    CloseConversationReceiptSchema,
    CloseReasonSchema,
    ConversationErrorSchema,
    ConversationRefSchema,
    DeliverySummarySchema,
    FanoutSendReceiptSchema,
    InboundMessageSchema,
    OutboundThreadMessageSchema,
    OutboundTopicMessageSchema,
    SendOptionsSchema,
    SendReceiptSchema,
    StartThreadOptionsSchema,
    StartThreadReceiptSchema,
    ThreadRefSchema,
    TopicCreateOptionsSchema,
    TopicCreateReceiptSchema,
    TopicInviteOptionsSchema,
    TopicInviteReceiptSchema,
    TopicJoinOptionsSchema,
    TopicJoinReceiptSchema,
    TopicLeaveOptionsSchema,
    TopicLeaveReceiptSchema,
    TopicPostOptionsSchema,
    TopicRefSchema,
    ConversationIdSchema,
    MessageIdSchema,
    CorrelationIdSchema,
    IdempotencyKeySchema,
    AgentIdSchema,
    MemberIdSchema,
    InviteTokenSchema,
    JsonValueSchema,
    TopicMemberSchema,
    TopicSelectorSchema,
    ResolvedTopicMemberSchema,
    TopicDeclineOptionsSchema,
    TopicDeclineReceiptSchema,
    ThreadStatusSchema,
} from './schemas.js';
import type { ConversationProjectionSchema } from './projection.js';
import type {
    AppendSignalInput,
    ReadProjectionOptions,
    ReadProjectionReceipt,
    TopicProjectionToken,
} from './topicProjection.js';

export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type MemberId = z.infer<typeof MemberIdSchema>;
export type InviteToken = z.infer<typeof InviteTokenSchema>;
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type ResolvedTopicMember = z.infer<typeof ResolvedTopicMemberSchema>;

export type ThreadRef = z.infer<typeof ThreadRefSchema>;
export type TopicRef = z.infer<typeof TopicRefSchema>;
export type ConversationRef = z.infer<typeof ConversationRefSchema>;
export type ConversationError = z.infer<typeof ConversationErrorSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type CloseReason = z.infer<typeof CloseReasonSchema>;

export type TopicMember = z.infer<typeof TopicMemberSchema>;
export type TopicSelector = z.infer<typeof TopicSelectorSchema>;

export type OutboundThreadMessage = z.infer<typeof OutboundThreadMessageSchema>;
export type OutboundTopicMessage = z.infer<typeof OutboundTopicMessageSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type SendReceipt = z.infer<typeof SendReceiptSchema>;
export type DeliverySummary = z.infer<typeof DeliverySummarySchema>;
export type FanoutSendReceipt = z.infer<typeof FanoutSendReceiptSchema>;

export type StartThreadOptions = z.infer<typeof StartThreadOptionsSchema>;
export type SendOptions = z.infer<typeof SendOptionsSchema>;
export type CloseConversationOptions = z.infer<typeof CloseConversationOptionsSchema>;
export type ArchiveConversationOptions = z.infer<typeof ArchiveConversationOptionsSchema>;

export type TopicCreateOptions = z.infer<typeof TopicCreateOptionsSchema>;
export type TopicInviteOptions = z.infer<typeof TopicInviteOptionsSchema>;
export type TopicJoinOptions = z.infer<typeof TopicJoinOptionsSchema>;
export type TopicDeclineOptions = z.infer<typeof TopicDeclineOptionsSchema>;
export type TopicLeaveOptions = z.infer<typeof TopicLeaveOptionsSchema>;
export type TopicPostOptions = z.infer<typeof TopicPostOptionsSchema>;

export type StartThreadReceipt = z.infer<typeof StartThreadReceiptSchema>;
export type TopicCreateReceipt = z.infer<typeof TopicCreateReceiptSchema>;
export type TopicInviteReceipt = z.infer<typeof TopicInviteReceiptSchema>;
export type TopicJoinReceipt = z.infer<typeof TopicJoinReceiptSchema>;
export type TopicDeclineReceipt = z.infer<typeof TopicDeclineReceiptSchema>;
export type TopicLeaveReceipt = z.infer<typeof TopicLeaveReceiptSchema>;
export type CloseConversationReceipt = z.infer<typeof CloseConversationReceiptSchema>;
export type ArchiveConversationReceipt = z.infer<typeof ArchiveConversationReceiptSchema>;

export type ConversationProjection = z.infer<typeof ConversationProjectionSchema>;

export type ConversationApi = {
    startThread: (options: StartThreadOptions) => Promise<StartThreadReceipt>;
    send: (
        thread: ThreadRef,
        message: OutboundThreadMessage,
        options?: SendOptions
    ) => Promise<SendReceipt>;
    createTopic: (options: TopicCreateOptions) => Promise<TopicCreateReceipt>;
    invite: (options: TopicInviteOptions) => Promise<TopicInviteReceipt>;
    join: (topic: TopicRef, options: TopicJoinOptions) => Promise<TopicJoinReceipt>;
    decline: (topic: TopicRef, options: TopicDeclineOptions) => Promise<TopicDeclineReceipt>;
    leave: (topic: TopicRef, options?: TopicLeaveOptions) => Promise<TopicLeaveReceipt>;
    post: (
        topic: TopicRef,
        message: OutboundTopicMessage,
        options?: TopicPostOptions
    ) => Promise<FanoutSendReceipt>;
    close: (
        ref: ConversationRef,
        options?: CloseConversationOptions
    ) => Promise<CloseConversationReceipt>;
    archive: (
        ref: ConversationRef,
        options?: ArchiveConversationOptions
    ) => Promise<ArchiveConversationReceipt>;
    readProjection: (
        topic: TopicRef,
        token: TopicProjectionToken<unknown>,
        options?: ReadProjectionOptions
    ) => Promise<ReadProjectionReceipt>;
    appendSignal: (
        topic: TopicRef,
        input: AppendSignalInput,
        options?: TopicPostOptions
    ) => Promise<FanoutSendReceipt>;
};
