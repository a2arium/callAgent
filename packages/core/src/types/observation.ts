import { z } from 'zod';

export const ObservationProvenanceSchema = z.object({
    ts: z.number(),
    turn: z.number(),
    id: z.string().optional(),
    toolId: z.string().optional(),
    correlationId: z.string().optional()
});

export type ObservationProvenance = z.infer<typeof ObservationProvenanceSchema>;

export const ExecErrorPayloadSchema = z.object({
    code: z.string(),
    message: z.string()
});

export type ExecErrorPayload = z.infer<typeof ExecErrorPayloadSchema>;

export const UserEnvelopeSchema = z.object({
    token: z.string(),
    value: z.unknown()
});

export type UserEnvelope = z.infer<typeof UserEnvelopeSchema>;

export const ToolEnvelopeSchema = z.object({
    token: z.string(),
    tool: z.string(),
    result: z.unknown().optional(),
    error: ExecErrorPayloadSchema.optional()
});

export type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

export const ChildEnvelopeSchema = z.object({
    token: z.string(),
    agentId: z.string().optional(),
    childTaskId: z.string().optional(),
    result: z.unknown().optional(),
    error: ExecErrorPayloadSchema.optional(),
    executionMetadata: z.object({
        timings: z.unknown().optional(),
        rewards: z.unknown().optional(),
        state: z.string().optional(),
        timestamp: z.string().optional()
    }).optional()
});

export type ChildEnvelope = z.infer<typeof ChildEnvelopeSchema>;

// Shared properties for all observation types
const BaseObservationProps = {
    provenance: ObservationProvenanceSchema.optional(),
    error: ExecErrorPayloadSchema.optional()
};

export const ObservationSchema = z.discriminatedUnion('source', [
    z.object({ 
        source: z.literal('user'), 
        kind: z.enum(['input.provided', 'input.cancelled']), 
        payload: UserEnvelopeSchema,
        ...BaseObservationProps
    }),
    z.object({ 
        source: z.literal('tool'), 
        kind: z.enum(['tool.completed', 'tool.failed', 'tool.progress']), 
        payload: ToolEnvelopeSchema,
        ...BaseObservationProps
    }),
    z.object({ 
        source: z.literal('child'), 
        kind: z.enum(['child.completed', 'child.failed', 'child.progress']), 
        payload: ChildEnvelopeSchema,
        ...BaseObservationProps
    }),
    z.object({ 
        source: z.literal('internal'), 
        kind: z.enum([
            'llm.responded', 
            'plan.proposed', 
            'plan.updated', 
            'goal.updated', 
            'validation.failed', 
            'state.noted'
        ]), 
        payload: z.unknown(),
        ...BaseObservationProps
    }),
    z.object({ 
        source: z.literal('env'), 
        kind: z.enum(['config.updated', 'clock.tick', 'snapshot.available', 'external.event']), 
        payload: z.unknown(),
        ...BaseObservationProps
    })
]);

export type Observation = z.infer<typeof ObservationSchema>;
