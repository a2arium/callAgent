import { z } from 'zod';
import { ExecutableActionSchema, type ExecutableAction } from './intent.js';
import { ExecErrorPayloadSchema, type ExecErrorPayload } from './observation.js';

export const ExecResultSchema = z.object({
    status: z.enum(['ok', 'error']),
    data: z.unknown().optional(),
    error: ExecErrorPayloadSchema.optional(),
    receipts: z.unknown().optional(),
    correlationId: z.string().optional(),
    toolId: z.string().optional(),
    ts: z.number().optional(),
});

export type ExecResult<
    Data = unknown,
    ErrorPayload extends ExecErrorPayload = ExecErrorPayload
> = {
    status: 'ok' | 'error';
    data?: Data;
    error?: ErrorPayload;
    receipts?: unknown;
    correlationId?: string;
    toolId?: string;
    ts?: number;
};

export const ExecOutcomeSchema = z.object({
    action: ExecutableActionSchema,
    result: ExecResultSchema,
});

export type ExecOutcome<
    Data = unknown,
    ErrorPayload extends ExecErrorPayload = ExecErrorPayload
> = {
    action: ExecutableAction;
    result: ExecResult<Data, ErrorPayload>;
};
