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
import type { RuntimeStreamEvent } from '../../streaming/runtimeStreamEvents.js';
import type { TopicSelectorPolicyRegistry } from './TopicSelectorPolicyRegistry.js';
import type { StopPolicyRegistry } from '../../public-types/conversation/stopPolicy.js';
import type { BackpressureManager, TopicPostBackpressureSample } from './BackpressureManager.js';
import type { ResolvedAgentCommunication } from './CapabilityValidator.js';

export type ConversationServiceDeps = {
    routeTargetForThread: (params: {
        tenantId: string;
        threadId: string;
        recipientAgentId: string;
    }) => ConversationRouteTarget;
    /** Run one cold turn on the thread-bound recipient session after inbox delivery. */
    activateConversationRecipient: (params: ConversationActivateParams) => Promise<ConversationActivateResult>;
    publishConversationEvent?: (channel: string, event: unknown) => Promise<void>;
    publishRuntimeEvent?: (params: { sessionId: string; event: RuntimeStreamEvent }) => Promise<void>;
    /** Wall clock by default; tests override for deterministic invite TTL/expiry. */
    clock?: Clock;
    messageLog: MessageLog;
    /**
     * Returns idle TTL in ms for new/sent threads, or `null` to disable TTL.
     * When omitted from deps, callers should default to 3600000 in the composition root.
     */
    /**
     * Thread idle TTL from the **calling agent's** manifest (`communication.threadTtlMs`).
     * `null` disables TTL; omitted manifest field → framework default (1h) inside the resolver.
     */
    resolveThreadTtlMs?: (agentId: string) => number | null;
    /** Registered `selector_policy` implementations; defaults to an empty registry when omitted. */
    topicSelectorPolicyRegistry?: TopicSelectorPolicyRegistry;
    /** Registered `custom` topic stop policies; defaults to an empty registry when omitted. */
    stopPolicyRegistry?: StopPolicyRegistry;
    /** Optional dispatch pressure tracking for topic fan-out (Phase 4b). */
    backpressureManager?: BackpressureManager;
    /** Manifest `communication` bag for an agent (Phase 4d capabilities). */
    resolveAgentCommunication?: (agentId: string) => ResolvedAgentCommunication | undefined;
    /** When true, topic delivery cold-starts a turn on the recipient (default false). */
    resolveWakeOnTopicMessage?: (agentId: string) => boolean;
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
        ref: ConversationRef,
        options?: ArchiveConversationOptions
    ) => Promise<ArchiveConversationReceipt>;
    /** Harness / ApiBinder: capture worst consumer backpressure sample during `post` (optional). */
    setTopicPostBackpressureSink?(
        sink: ((sample: TopicPostBackpressureSample | undefined) => void) | undefined
    ): void;
    readProjection: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        token: { projectionName: string },
        options?: import('../../public-types/conversation/topicProjection.js').ReadProjectionOptions
    ) => Promise<import('../../public-types/conversation/topicProjection.js').ReadProjectionReceipt>;
    appendSignal: (
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        input: import('../../public-types/conversation/topicProjection.js').AppendSignalInput,
        options?: TopicPostOptions
    ) => Promise<FanoutSendReceipt>;
};
