import { v7 as uuidv7 } from 'uuid';
import { BusEventSchema, CloudEventSchema, type BusEvent, type CloudEvent } from '../public-types/eventbus/schemas.js';

export function createBusEvent(input: {
    channel: string;
    partitionKey?: string;
    cloud: Omit<CloudEvent, 'specversion'> & Partial<Pick<CloudEvent, 'specversion'>>;
}): BusEvent {
    const cloud: CloudEvent = {
        specversion: '1.0',
        ...input.cloud,
    };
    CloudEventSchema.parse(cloud);
    const event: BusEvent = {
        channel: input.channel,
        eventId: uuidv7(),
        ts: new Date().toISOString(),
        partitionKey: input.partitionKey,
        payload: cloud,
    };
    BusEventSchema.parse(event);
    return event;
}

/** Extract CloudEvent `data` (e.g. legacy A2A task payloads) from a bus envelope. */
export function busEventData<T = unknown>(event: BusEvent): T | undefined {
    return event.payload.data as T | undefined;
}
