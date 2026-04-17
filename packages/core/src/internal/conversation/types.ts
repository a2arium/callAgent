import type {
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
    TopicLeaveOptions,
    TopicLeaveReceipt,
    TopicPostOptions,
    TopicRef,
    ConversationRef,
} from '../../public-types/conversation/types.js';

export type ConversationRouteTarget = {
    tenantId: string;
    sessionId: string;
    agentId: string;
};

export type ConversationActivateParams = {
    tenantId: string;
    threadId: string;
    routingSessionId: string;
    recipientAgentId: string;
    messageId: string;
    senderSessionId: string;
    senderAgentId: string;
};

export type ConversationActivateResult =
    | { ok: true }
    | {
          ok: false;
          error: { type: 'PluginMissing' | 'ActivationFailed' | 'RunTurnFailed'; message: string };
      };

export type ConversationServiceDeps = {
    routeTargetForThread: (params: {
        tenantId: string;
        threadId: string;
        recipientAgentId: string;
    }) => ConversationRouteTarget;
    /** Run one cold turn on the thread-bound recipient session after inbox delivery. */
    activateConversationRecipient: (params: ConversationActivateParams) => Promise<ConversationActivateResult>;
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
};
