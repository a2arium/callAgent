import type { BusEvent } from './schemas.js';

export type BusEventHandler = (event: BusEvent) => Promise<void>;

export type IEventBus = {
    /** Process-local buses must never receive rows claimed by another runtime. */
    readonly deliveryScope?: 'process' | 'shared';
    publish(event: BusEvent): Promise<void>;
    subscribe(channel: string, handler: BusEventHandler): Promise<{ unsubscribe: () => Promise<void> }>;
};
