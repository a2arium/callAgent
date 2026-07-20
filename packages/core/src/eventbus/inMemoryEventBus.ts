import { logger } from '@a2arium/callagent-utils';
import { BusEventSchema, type BusEvent } from '../public-types/eventbus/schemas.js';
import type { BusEventHandler, IEventBus } from '../public-types/eventbus/types.js';

const log = logger.createLogger({ prefix: 'EventBus' });

export type { IEventBus, BusEventHandler } from '../public-types/eventbus/types.js';

export function createInMemoryEventBus(): IEventBus {
    return new InMemoryEventBus();
}

export class InMemoryEventBus implements IEventBus {
    readonly deliveryScope = 'process' as const;
    private readonly handlers = new Map<string, Set<BusEventHandler>>();

    async publish(event: BusEvent): Promise<void> {
        BusEventSchema.parse(event);
        try {
            log.debug('Event published', {
                channel: event.channel,
                type: event.payload.type,
                subscriberCount: this.handlers.get(event.channel)?.size ?? 0,
            });
        } catch {
            /* noop */
        }
        const subs = this.handlers.get(event.channel);
        if (!subs) {
            return;
        }
        for (const handler of subs) {
            await handler(event);
        }
    }

    async subscribe(channel: string, handler: BusEventHandler): Promise<{ unsubscribe: () => Promise<void> }> {
        try {
            log.debug('Event subscription added', { channel });
        } catch {
            /* noop */
        }
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel)!.add(handler);
        return {
            unsubscribe: async () => {
                this.handlers.get(channel)?.delete(handler);
            },
        };
    }

    listenerCount(): number {
        let total = 0;
        for (const handlers of this.handlers.values()) {
            total += handlers.size;
        }
        return total;
    }

    removeAllListeners(): void {
        const count = this.listenerCount();
        if (count > 0) {
            log.debug(`Removing ${count} listeners from ${this.handlers.size} channels`);
        }
        this.handlers.clear();
    }
}
