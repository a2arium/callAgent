import type { NatsConnection, Subscription } from 'nats';
import { JSONCodec } from 'nats';
import { BusEventSchema, type BusEvent } from '@a2arium/callagent-core';
import type { BusEventHandler, IEventBus } from '@a2arium/callagent-core';
import { busSubject } from './subjectTokens.js';

const jc = JSONCodec<BusEvent>();

const DEFAULT_BUS_PREFIX = 'callagent.bus';
const DEFAULT_BACKPRESSURE_TENANT = '__nats_event_bus';

/**
 * Structural match for core `BackpressureManager` dispatch hooks (avoids pulling core types into this
 * package while `AdapterFactory` dynamic-imports us during the core `tsc` graph).
 */
export type NatsEventBusDispatchPressure = {
    dispatchStarted(
        tenantId: string,
        consumerId: string
    ): { state: string; unackedCount: number };
    dispatchAcknowledged(
        tenantId: string,
        consumerId: string
    ): { state: string; unackedCount: number };
};

export type NatsJetStreamEventBusOptions = {
    subjectPrefix?: string;
    /** Optional consumer-side dispatch accounting (e.g. core `BackpressureManager`). */
    backpressure?: NatsEventBusDispatchPressure;
    /** Tenant segment for `backpressure` keys; defaults to `__nats_event_bus`. */
    backpressureTenantId?: string;
};

export class NatsJetStreamEventBus implements IEventBus {
    readonly deliveryScope = 'shared' as const;
    private readonly subs = new Set<Subscription>();
    private readonly subjectPrefix: string;
    private readonly backpressure?: NatsEventBusDispatchPressure;
    private readonly backpressureTenantId: string;

    constructor(
        private readonly nc: NatsConnection,
        arg?: string | NatsJetStreamEventBusOptions
    ) {
        if (typeof arg === 'string') {
            this.subjectPrefix = arg;
            this.backpressureTenantId = DEFAULT_BACKPRESSURE_TENANT;
        } else if (arg && typeof arg === 'object') {
            this.subjectPrefix = arg.subjectPrefix ?? DEFAULT_BUS_PREFIX;
            this.backpressure = arg.backpressure;
            this.backpressureTenantId = arg.backpressureTenantId ?? DEFAULT_BACKPRESSURE_TENANT;
        } else {
            this.subjectPrefix = DEFAULT_BUS_PREFIX;
            this.backpressureTenantId = DEFAULT_BACKPRESSURE_TENANT;
        }
    }

    async publish(event: BusEvent): Promise<void> {
        BusEventSchema.parse(event);
        const subj = busSubject(this.subjectPrefix, event.channel);
        this.nc.publish(subj, jc.encode(event));
    }

    async subscribe(channel: string, handler: BusEventHandler): Promise<{ unsubscribe: () => Promise<void> }> {
        const subj = busSubject(this.subjectPrefix, channel);
        const consumerId = `chan:${channel}`;
        const sub = this.nc.subscribe(subj, {
            callback: (_err, msg) => {
                if (!msg?.data?.length) {
                    return;
                }
                try {
                    const parsed = BusEventSchema.safeParse(jc.decode(msg.data));
                    if (!parsed.success || parsed.data.channel !== channel) {
                        return;
                    }
                    const bp = this.backpressure;
                    if (bp) {
                        bp.dispatchStarted(this.backpressureTenantId, consumerId);
                    }
                    void Promise.resolve(handler(parsed.data)).finally(() => {
                        if (bp) {
                            bp.dispatchAcknowledged(this.backpressureTenantId, consumerId);
                        }
                    });
                } catch {
                    /* malformed payload */
                }
            },
        });
        this.subs.add(sub);
        return {
            unsubscribe: async () => {
                sub.unsubscribe();
                this.subs.delete(sub);
            },
        };
    }
}
