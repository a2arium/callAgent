import type {
    DurableSubscriptionAckParams,
    DurableSubscriptionEvent,
    DurableSubscriptionNackParams,
    DurableSubscriptionCursor,
} from './durableSubscription.schemas.js';

export type DurableSubscriptionHandler = (
    event: DurableSubscriptionEvent
) => Promise<'ack' | { nack: true; reason: string; retryAfterMs?: number }>;

export type DurableSubscription = {
    subscribe(params: {
        streamId: string;
        consumerId: string;
        handler: DurableSubscriptionHandler;
        startFrom?: 'earliest' | 'cursor' | { sequenceNumber: number };
    }): Promise<{ unsubscribe: () => Promise<void> }>;

    ack(params: DurableSubscriptionAckParams): Promise<void>;

    nack(params: DurableSubscriptionNackParams): Promise<void>;

    getCursor(params: { streamId: string; consumerId: string }): Promise<DurableSubscriptionCursor | null>;

    setCursor(params: DurableSubscriptionCursor): Promise<void>;
};
