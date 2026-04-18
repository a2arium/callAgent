import type { BusEvent } from './schemas.js';

export type BusEventHandler = (event: BusEvent) => Promise<void>;

export type IEventBus = {
    publish(event: BusEvent): Promise<void>;
    subscribe(channel: string, handler: BusEventHandler): Promise<{ unsubscribe: () => Promise<void> }>;
};
