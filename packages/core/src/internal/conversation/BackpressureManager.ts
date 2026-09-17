export type BackpressureConsumerState =
    | 'delivered'
    | 'buffered'
    | 'throttled'
    | 'paused'
    | 'dead-lettered';

export type BackpressureThresholds = {
    bufferThreshold: number;
    throttleThreshold: number;
    pauseThreshold: number;
    maxRetries: number;
};

export type TopicPostBackpressureSample = {
    consumerId: string;
    state: BackpressureConsumerState;
    unackedCount: number;
};

export const DEFAULT_BACKPRESSURE_THRESHOLDS: BackpressureThresholds = {
    bufferThreshold: 100,
    throttleThreshold: 200,
    pauseThreshold: 500,
    maxRetries: 5,
};

/**
 * Single owner of consumer-side dispatch pressure (Phase 4b). Counts in-flight dispatches per consumer.
 */
export class BackpressureManager {
    private readonly unacked = new Map<string, number>();

    constructor(
        private readonly thresholds: BackpressureThresholds = DEFAULT_BACKPRESSURE_THRESHOLDS,
        private readonly onTransition?: (ev: {
            tenantId: string;
            consumerId: string;
            from: BackpressureConsumerState;
            to: BackpressureConsumerState;
            unackedCount: number;
            ts: string;
        }) => void,
        private readonly nowIso: () => string = () => new Date().toISOString()
    ) {}

    private key(tenantId: string, consumerId: string): string {
        return `${tenantId}:${consumerId}`;
    }

    private stateForCount(n: number): BackpressureConsumerState {
        if (n >= this.thresholds.pauseThreshold) {
            return 'paused';
        }
        if (n >= this.thresholds.throttleThreshold) {
            return 'throttled';
        }
        if (n >= this.thresholds.bufferThreshold) {
            return 'buffered';
        }
        return 'delivered';
    }

    dispatchStarted(
        tenantId: string,
        consumerId: string
    ): { state: BackpressureConsumerState; unackedCount: number } {
        const k = this.key(tenantId, consumerId);
        const prev = this.unacked.get(k) ?? 0;
        const next = prev + 1;
        this.unacked.set(k, next);
        const from = this.stateForCount(prev);
        const to = this.stateForCount(next);
        if (from !== to) {
            this.onTransition?.({
                tenantId,
                consumerId,
                from,
                to,
                unackedCount: next,
                ts: this.nowIso(),
            });
        }
        return { state: to, unackedCount: next };
    }

    dispatchAcknowledged(
        tenantId: string,
        consumerId: string
    ): { state: BackpressureConsumerState; unackedCount: number } {
        const k = this.key(tenantId, consumerId);
        const prev = this.unacked.get(k) ?? 0;
        const next = Math.max(0, prev - 1);
        this.unacked.set(k, next);
        const from = this.stateForCount(prev);
        const to = this.stateForCount(next);
        if (from !== to) {
            this.onTransition?.({
                tenantId,
                consumerId,
                from,
                to,
                unackedCount: next,
                ts: this.nowIso(),
            });
        }
        return { state: to, unackedCount: next };
    }
}
