import type { MentalState } from '@a2arium/callagent-core';

/** Must match conversation-reference-agent Phase 2 demo topic id. */
export const DEMO_TOPIC_PHASE2_ID = 'topic-conv-ref-phase2' as const;

export type Sensory = {
    latestThreadId?: string;
    latestSequence?: number;
    latestInboundMessageId?: string;
    replied?: boolean;
    /** Topic inbound (fan-out copy addressed to this agent). */
    topicMessageSeq?: number;
    topicMessageId?: string;
    topicReplied?: boolean;
    topicJoined?: boolean;
    topicLeft?: boolean;
    pendingInviteToken?: string;
    wantLeaveTopic?: boolean;
};

export type Obs =
    | { kind: 'conversation'; threadId: string; sequenceNumber: number; inboundMessageId: string }
    | {
          kind: 'topic_message';
          topicId: string;
          sequenceNumber: number;
          inboundMessageId: string;
      }
    | { kind: 'topic_join'; token: string }
    | { kind: 'topic_joined' }
    | { kind: 'topic_reply_done' }
    | { kind: 'topic_left_done' }
    | { kind: 'leave_topic' }
    | { kind: 'reply_sent'; threadId: string }
    | { kind: 'idle' };

export type ExecPayload = {
    acknowledged?: boolean;
    threadId?: string;
    replyOutbound?: boolean;
    outboundMessageId?: string;
    topicId?: string;
    topicJoined?: boolean;
    topicReplySent?: boolean;
    topicLeft?: boolean;
    joinContinue?: boolean;
    topicReplyContinue?: boolean;
    leaveContinue?: boolean;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;
