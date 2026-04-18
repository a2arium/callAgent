import { z } from 'zod';
import type { MessageLogRecord } from '../messageLog/schemas.js';
import {
    ConversationErrorSchema,
    CorrelationIdSchema,
    IdempotencyKeySchema,
    MemberIdSchema,
} from './schemas.js';
import { SignalKindSchema } from './signal.js';

export type TopicProjectionDefinition<T = unknown> = {
    name: string;
    stateSchema: z.ZodType<T>;
    initial: () => T;
    reduce: (state: T, record: MessageLogRecord) => T;
};

export type TopicProjectionToken<TState = unknown> = {
    readonly projectionName: string;
    readonly __state?: TState;
};

export function defineTopicProjection<S extends z.ZodTypeAny>(opts: {
    projectionName: string;
    stateSchema: S;
    initial: () => z.infer<S>;
    reduce: (state: z.infer<S>, record: MessageLogRecord) => z.infer<S>;
}): {
    token: TopicProjectionToken<z.infer<S>>;
    definition: TopicProjectionDefinition<z.infer<S>>;
} {
    const definition: TopicProjectionDefinition<z.infer<S>> = {
        name: opts.projectionName,
        stateSchema: opts.stateSchema as z.ZodType<z.infer<S>>,
        initial: opts.initial,
        reduce: opts.reduce,
    };
    return {
        token: { projectionName: opts.projectionName } as TopicProjectionToken<z.infer<S>>,
        definition,
    };
}

export const ReadProjectionOptionsSchema = z
    .object({
        /** Inclusive upper bound on `MessageLogRecord.sequenceNumber` (omit = no upper bound). */
        asOfSequence: z.number().int().nonnegative().optional(),
        fromSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(10_000).optional(),
    })
    .strict();

export type ReadProjectionOptions = z.infer<typeof ReadProjectionOptionsSchema>;

export const ReadProjectionReceiptSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        state: z.unknown(),
        asOfSequence: z.number().int().nonnegative(),
    }),
    z.object({
        status: z.literal('rejected'),
        error: ConversationErrorSchema,
    }),
]);

export type ReadProjectionReceipt = z.infer<typeof ReadProjectionReceiptSchema>;

export const AppendSignalInputSchema = z
    .object({
        signalType: SignalKindSchema,
        payload: z.unknown().optional(),
        senderMemberId: MemberIdSchema.optional(),
        correlationId: CorrelationIdSchema.optional(),
        idempotencyKey: IdempotencyKeySchema.optional(),
    })
    .strict();

export type AppendSignalInput = z.infer<typeof AppendSignalInputSchema>;
