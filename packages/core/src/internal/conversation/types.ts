import type {
    ArchiveConversationOptions,
    ArchiveConversationReceipt,
    CloseConversationOptions,
    CloseConversationReceipt,
    FanoutSendReceipt,
    OutboundThreadMessage,
    OutboundTopicMessage,
    SendOptions,
    SendReceipt,
    StartThreadOptions,
    StartThreadReceipt,
    ThreadRef,
    TopicCreateOptions,
    TopicCreateReceipt,
    TopicInviteOptions,
    TopicInviteReceipt,
    TopicJoinOptions,
    TopicJoinReceipt,
    TopicDeclineOptions,
    TopicDeclineReceipt,
    TopicLeaveOptions,
    TopicLeaveReceipt,
    TopicPostOptions,
    TopicRef,
    ConversationRef,
} from '../../public-types/conversation/types.js';
import type { Clock } from './Clock.js';

export type ConversationRouteTarget = {
    tenantId: string;
    sessionId: string;
    agentId: string;
};

export type ConversationActivateParams = {
    kind: 'thread';
    tenantId: string;
    threadId: string;
    routingSessionId: string;
    recipientAgentId: string;
    messageId: string;
    senderSessionId: string;
    senderAgentId: string;
} | {
    kind: 'topic';
    tenantId: string;
    topicId: string;
    routingSessionId: string;
    recipientAgentId: string;
    senderSessionId: string;
    senderAgentId: string;
} | {
    kind: 'invite';
    tenantId: string;
    topicId: string;
    routingSessionId: string;
    recipientAgentId: string;
    inviterAgentId: string;
    token: string;
};

export type ConversationActivateResult =
    | { ok: true }
    | {
          ok: false;
          error: { type: 'PluginMissing' | 'ActivationFailed' | 'RunTurnFailed'; message: string };
      };

import type { MessageLog } from '../../public-types/messageLog/types.js';

export type ConversationServiceDeps = {
    routeTargetForThread: (params: {
        tenantId: string;
        threadId: string;
        recipientAgentId: string;
    }) => ConversationRouteTarget;
    /** Run one cold turn on the thread-bound recipient session after inbox delivery. */
    activateConversationRecipient: (params: ConversationActivateParams) => Promise<ConversationActivateResult>;
    publishConversationEvent?: (channel: string, event: unknown) => Promise<void>;
    /** Wall clock by default; tests override for deterministic invite TTL/expiry. */
    clock?: Clock;
    messageLog: MessageLog;
    /**
     * Returns idle TTL in ms for new/sent threads, or `null` to disable TTL.
     * When omitted from deps, callers should default to 3600000 in the composition root.
     */
    resolveThreadTtlMs?: () => number | null;
};

export type InternalConversationApi = {
    startThread: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: StartThreadOptions
    ) => Promise<StartThreadReceipt>;
    send: (
        tenantId: string,
        senderSessionId: string,
        thread: ThreadRef,
        message: OutboundThreadMessage,
        options?: SendOptions
    ) => Promise<SendReceipt>;
    createTopic: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: TopicCreateOptions
    ) => Promise<TopicCreateReceipt>;
    invite: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: TopicInviteOptions
    ) => Promise<TopicInviteReceipt>;
    join: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options: TopicJoinOptions
    ) => Promise<TopicJoinReceipt>;
    leave: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options?: TopicLeaveOptions
    ) => Promise<TopicLeaveReceipt>;
    decline: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options: TopicDeclineOptions
    ) => Promise<TopicDeclineReceipt>;
    post: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        message: OutboundTopicMessage,
        options?: TopicPostOptions
    ) => Promise<FanoutSendReceipt>;
    close: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        ref: ConversationRef,
        options?: CloseConversationOptions
    ) => Promise<CloseConversationReceipt>;
    archive: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        ref: ThreadRef,
        options?: ArchiveConversationOptions
    ) => Promise<ArchiveConversationReceipt>;
};
