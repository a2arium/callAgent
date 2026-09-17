import { z } from 'zod';

/**
 * ── Invariant Error Code Schema ──
 * Closed enum of machine-readable error codes.
 */
export const InvariantErrorCodeSchema = z.enum([
    // Stage invariants
    'STAGE_REQUIRES_KEY',
    'STAGE_FORBIDS_KEY',

    // Token validation
    'INPUT_TOKEN_NOT_FOUND',
    'INPUT_TOKEN_EXPIRED',
    'TOOL_TOKEN_NOT_FOUND',
    'CHILD_TOKEN_NOT_FOUND',
    'EXTERNAL_EVENT_TOKEN_NOT_FOUND',
    'TOKEN_MISMATCH',

    // Observation validation
    'OBSERVATION_VALIDATION_FAILED',

    // Transition invariants
    'CONTINUE_WITHOUT_OBSERVATIONS',
    'AWAIT_MISSING_TOKEN',
    'TERMINAL_WITH_PENDING',

    // Goal invariants
    'GOAL_NOT_FOUND',
    'GOAL_HAS_ACTIVE_CHILDREN',
    'GOAL_PRIORITY_OUT_OF_RANGE',

    // Budget enforcement
    'BUDGET_TURNS_EXCEEDED',
    'BUDGET_LATENCY_EXCEEDED',
    'BUDGET_COST_EXCEEDED',

    // Session / configuration
    'SESSION_NOT_FOUND',
    'LIMIT_MAX_PROMPTS_EXCEEDED'
]);

export type InvariantErrorCode = z.infer<typeof InvariantErrorCodeSchema>;

/**
 * ── Inbox Summary Schema ──
 */
export const InboxSummarySchema = z.object({
    count: z.number().int().nonnegative(),
    entries: z.array(z.object({
        source: z.string(),
        kind: z.string()
    })).optional()
});

export type InboxSummary = z.infer<typeof InboxSummarySchema>;

/**
 * ── Invariant Error Detail Schema (Discriminated Union) ──
 */
export const InvariantErrorDetailSchema = z.discriminatedUnion('type', [
    // Stage invariant violations
    z.object({
        type: z.literal('stage_invariant'),
        stage: z.string(),
        required: z.array(z.string()).optional(),
        forbidden: z.array(z.string()).optional(),
        pendingSnapshot: z.unknown().optional()
    }),

    // Token validation failures
    z.object({
        type: z.literal('token_validation'),
        category: z.enum(['input', 'tool', 'child', 'event']),
        token: z.string().optional(),
        expectedToken: z.string().optional(),
        reason: z.enum(['missing', 'expired', 'mismatch', 'unknown_token']),
        pendingSnapshot: z.unknown().optional()
    }),

    // Observation validation failures
    z.object({
        type: z.literal('observation_validation'),
        source: z.string().optional(),
        kind: z.string().optional(),
        reason: z.string(),
        observationIndex: z.number().int().optional(),
        inboxSummary: InboxSummarySchema.optional(),
        validation: z.object({
            failed: z.boolean(),
            errors: z.array(z.unknown()).optional()
        }).optional()
    }),

    // Session / configuration invariant violations
    z.object({
        type: z.literal('session_config'),
        reason: z.enum(['session_not_found', 'limit_max_prompts_exceeded']),
        taskId: z.string().optional(),
        limit: z.number().optional(),
        actual: z.number().optional()
    }),

    // Transition invariant violations
    z.object({
        type: z.literal('transition_invariant'),
        transitionKind: z.string(),
        reason: z.string(),
        pendingSnapshot: z.unknown().optional()
    }),

    // Goal API invariant violations
    z.object({
        type: z.literal('goal_invariant'),
        goalId: z.string().optional(),
        reason: z.enum([
            'goal_not_found', 'goal_has_active_children', 'priority_out_of_range'
        ])
    }),

    // Budget enforcement failures
    z.object({
        type: z.literal('budget_exceeded'),
        budget: z.enum(['turns', 'latency', 'cost']),
        limit: z.number(),
        actual: z.number()
    })
]);

export type InvariantErrorDetail = z.infer<typeof InvariantErrorDetailSchema>;

/**
 * ── Invariant Error Payload Schema ──
 */
export const InvariantErrorPayloadSchema = z.object({
    code: InvariantErrorCodeSchema,
    message: z.string(),
    stage: z.string().optional(),
    detail: InvariantErrorDetailSchema,
    correlationId: z.string().optional(),
    turnId: z.string().optional()
});

export type InvariantErrorPayload = z.infer<typeof InvariantErrorPayloadSchema>;

/**
 * Optional envelope context for invariant errors (stage, correlationId, turnId).
 * Used by throwInvariantError and ctx.throw.
 */
export type InvariantErrorContext = {
    stage?: string;
    correlationId?: string;
    turnId?: string;
};
