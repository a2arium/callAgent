import { z } from 'zod';
import { MessageIdSchema } from '../conversation/schemas.js';
import { MessageLogRecordSchema } from './schemas.js';

export const DurableSubscriptionAckParamsSchema = z.object({
    streamId: z.string().min(1),
    consumerId: z.string().min(1),
    sequenceNumber: z.number().int().nonnegative(),
    messageId: MessageIdSchema,
});

export const DurableSubscriptionNackParamsSchema = z.object({
    streamId: z.string().min(1),
    consumerId: z.string().min(1),
    sequenceNumber: z.number().int().nonnegative(),
    messageId: MessageIdSchema,
    reason: z.string().min(1).max(500),
    retryAfterMs: z.number().int().nonnegative().optional(),
});

export const DurableSubscriptionCursorSchema = z.object({
    streamId: z.string().min(1),
    consumerId: z.string().min(1),
    sequenceNumber: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
});

export const DurableSubscriptionEventSchema = z.object({
    streamId: z.string().min(1),
    consumerId: z.string().min(1),
    record: MessageLogRecordSchema,
    deliveryAttempt: z.number().int().positive(),
});

export type DurableSubscriptionAckParams = z.infer<typeof DurableSubscriptionAckParamsSchema>;
export type DurableSubscriptionNackParams = z.infer<typeof DurableSubscriptionNackParamsSchema>;
export type DurableSubscriptionCursor = z.infer<typeof DurableSubscriptionCursorSchema>;
export type DurableSubscriptionEvent = z.infer<typeof DurableSubscriptionEventSchema>;
