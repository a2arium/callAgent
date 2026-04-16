import type { MentalState } from '@a2arium/callagent-core';

export type Sensory = {
    latestThreadId?: string;
    latestSequence?: number;
    /** Id of the inbound `message.received` we are replying to (one reply idempotency bucket per inbound). */
    latestInboundMessageId?: string;
    /** Set after we have persisted an outbound reply on the thread. */
    replied?: boolean;
};

export type Obs =
    | { kind: 'conversation'; threadId: string; sequenceNumber: number; inboundMessageId: string }
    | { kind: 'reply_sent'; threadId: string }
    | { kind: 'idle' };

export type ExecPayload = {
    acknowledged?: boolean;
    threadId?: string;
    replyOutbound?: boolean;
    outboundMessageId?: string;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;
