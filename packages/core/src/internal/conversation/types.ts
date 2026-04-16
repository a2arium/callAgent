import type {
    OutboundThreadMessage,
    SendOptions,
    SendReceipt,
    StartThreadOptions,
    StartThreadReceipt,
    ThreadRef,
    CloseConversationOptions,
    CloseConversationReceipt,
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
    close: (
        tenantId: string,
        thread: ThreadRef,
        options?: CloseConversationOptions
    ) => Promise<CloseConversationReceipt>;
};

