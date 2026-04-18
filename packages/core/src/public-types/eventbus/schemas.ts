import { z } from 'zod';

export const CloudEventSchema = z.object({
    specversion: z.literal('1.0'),
    id: z.string().min(1),
    type: z.string().min(1),
    source: z.string().min(1),
    time: z.string().datetime(),
    datacontenttype: z.string().optional(),
    data: z.unknown().optional(),
});
export type CloudEvent = z.infer<typeof CloudEventSchema>;

export const BusEventSchema = z.object({
    channel: z.string().min(1).max(512),
    eventId: z.string().uuid(),
    ts: z.string().datetime(),
    partitionKey: z.string().min(1).max(512).optional(),
    payload: CloudEventSchema,
});
export type BusEvent = z.infer<typeof BusEventSchema>;
