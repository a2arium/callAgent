import type { MentalState } from '@a2arium/callagent-core';

export const DEMO_THREAD_ID = 'thread-conv-ref-1' as const;
export const DEMO_CHILD_AGENT_ID = 'conversation-responder-agent' as const;

export type Sensory = {
    userText?: string;
    /** Drives policy after learning merges the latest observation. */
    demoStage?: 'idle' | 'want_open' | 'want_followup' | 'done';
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
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;
