import type { MentalState } from '@a2arium/callagent-core';

export const DEMO_THREAD_ID = 'thread-conv-ref-1' as const;
/** Legacy minimal topic id (kept for any external scripts). */
export const DEMO_TOPIC_ID = 'topic-conv-ref-1' as const;
/** Phase 2 full demo topic (3 members, selectors, invite, close). */
export const DEMO_TOPIC_PHASE2_ID = 'topic-conv-ref-phase2' as const;
export const DEMO_CHILD_AGENT_ID = 'conversation-responder-agent' as const;
/** Third participant (routing session override in createTopic). */
export const DEMO_THIRD_MEMBER_ID = 'topic-demo-third-member' as const;
/** Invited-only member (join demonstrated by conversation-responder-agent). */
export const DEMO_INVITEE_AGENT_ID = 'topic-demo-invitee' as const;

export type Sensory = {
    userText?: string;
    /** Drives policy after learning merges the latest observation. */
    demoStage?:
        | 'idle'
        | 'want_open'
        | 'want_followup'
        | 'want_phase2'
        | 'want_phase2_close'
        | 'done';
    openOutboundMessageId?: string;
    openOutboundSequence?: number;
    lastInboundMessageId?: string;
    lastInboundSequence?: number;
};

export type Obs =
    | { kind: 'user_message'; text: string }
    | { kind: 'conversation_delivery'; threadId: string; sequenceNumber: number; inboundMessageId?: string }
    | {
          kind: 'thread_opened';
          threadId: string;
          openOutboundMessageId?: string;
          openOutboundSequence?: number;
      }
    | { kind: 'idle' };

export type ExecPayload = {
    threadId?: string;
    lastDedupeHit?: boolean;
    outgoingSteps?: number;
    awaitingReply?: boolean;
    idle?: boolean;
    openOutboundMessageId?: string;
    openOutboundSequence?: number;
    followUpFirstMessageId?: string;
    followUpReplayMessageId?: string;
    followUpFirstSequence?: number;
    followUpReplaySequence?: number;
    topicId?: string;
    topicPostDedupeHit?: boolean;
    /** Phase 2 owner-side demo finished (create → selectors → invite token). */
    phase2DemoComplete?: boolean;
    /** Topic closed after `phase2-close` user line. */
    phase2CloseComplete?: boolean;
    inviteToken?: string;
    /** Round-robin demo: recipient agent id per sequential post (witness). */
    rrRecipients?: string[];
    /** Explicit 2a seats for the same owner `agentId`. */
    ownerSeatMemberIds?: string[];
    /** Sender seat used for topic posts in the phase2 demo. */
    senderMemberIdUsed?: string;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;
