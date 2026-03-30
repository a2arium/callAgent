import { z } from 'zod';
import { InvariantErrorPayloadSchema } from './invariantError.js';

/** Module names for turn-failure attribution; must match FrameworkModule in utils/errors.js */
const FrameworkModuleNameSchema = z.enum([
    'attention',
    'perception',
    'learning',
    'policy',
    'shield',
    'execution',
    'transition',
]);

export const ManifestSourceSchema = z.enum(['defaultPath', 'pathOverride', 'inline']);
export type ManifestSource = z.infer<typeof ManifestSourceSchema>;

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]);
type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        JsonPrimitiveSchema,
        z.array(JsonValueSchema),
        z.record(z.string(), JsonValueSchema),
    ])
);

export const InboxObservationSummarySchema = z.object({
    source: z.string(),
    kind: z.string(),
    hasToken: z.boolean().optional(),
    token: z.string().optional(),
    payload: JsonValueSchema.optional(),
});
export type InboxObservationSummary = z.infer<typeof InboxObservationSummarySchema>;

export const ShieldTraceSchema = z.object({
    action: z.enum(['pass', 'transform', 'defer', 'veto']),
    note: z.string().optional(),
    reason: z.string().optional(),
});
export type ShieldTrace = z.infer<typeof ShieldTraceSchema>;

export const IntentTraceSchema = z.object({
    kind: z.string(),
    summary: z.string().optional(),
    data: JsonValueSchema.optional(),
});
export type IntentTrace = z.infer<typeof IntentTraceSchema>;

export const PerceptionTraceSchema = z.object({
    kind: z.string().optional(),
    summary: z.string().optional(),
    data: JsonValueSchema.optional(),
});
export type PerceptionTrace = z.infer<typeof PerceptionTraceSchema>;

export const ExecActionTraceSchema = z.object({
    kind: z.string(),
    token: z.string().optional(),
    summary: z.string().optional(),
    data: JsonValueSchema.optional(),
});
export type ExecActionTrace = z.infer<typeof ExecActionTraceSchema>;

export const ExecResultTraceSchema = z.object({
    status: z.enum(['ok', 'error']),
    summary: z.string().optional(),
    data: JsonValueSchema.optional(),
    error: JsonValueSchema.optional(),
    correlationId: z.string().optional(),
});
export type ExecResultTrace = z.infer<typeof ExecResultTraceSchema>;

export const TransitionTraceSchema = z.object({
    kind: z.enum(['continue', 'await_input', 'await_tool', 'await_child', 'complete', 'fail']),
    token: z.string().optional(),
    summary: z.string().optional(),
    result: JsonValueSchema.optional(),
});
export type TransitionTrace = z.infer<typeof TransitionTraceSchema>;

export const PendingSummarySchema = z.object({
    inputTokens: z.array(z.string()),
    toolTokens: z.array(z.object({ token: z.string(), tool: z.string().optional() })),
    childTokens: z.array(z.object({ token: z.string(), agentId: z.string().optional() })),
    stage: z.string().optional(),
});
export type PendingSummary = z.infer<typeof PendingSummarySchema>;

export const TurnTimingsSchema = z.object({
    attentionMs: z.number(),
    perceptionMs: z.number(),
    learningMs: z.number(),
    policyMs: z.number(),
    shieldMs: z.number(),
    executionMs: z.number(),
    transitionMs: z.number(),
    totalMs: z.number(),
});
export type TurnTimings = z.infer<typeof TurnTimingsSchema>;

export const TurnUsageSchema = z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    totalCost: z.number().optional(),
    currency: z.string().optional(),
    llmCalls: z.number().optional(),
    toolCalls: z.number().optional(),
    childCalls: z.number().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

export const StageInvariantCheckResultSchema = z.object({
    required: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
    ok: z.boolean(),
    failedKey: z.string().optional(),
});

export const LLMCallTraceSchema = z.object({
    model: z.string(),
    provider: z.string().optional(),
    durationMs: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cost: z.number().optional(),
    module: z.string().optional(),
});
export type LLMCallTrace = z.infer<typeof LLMCallTraceSchema>;

export const ToolCallTraceSchema = z.object({
    tool: z.string(),
    durationMs: z.number().optional(),
    status: z.enum(['success', 'failure']).optional(),
    module: z.string().optional(),
});
export type ToolCallTrace = z.infer<typeof ToolCallTraceSchema>;

export const ChildCallTraceSchema = z.object({
    token: z.string(),
    agentId: z.string().optional(),
    childTaskId: z.string().optional(),
    awaitCompletion: z.boolean().optional(),
    durationMs: z.number().optional(),
    status: z
        .enum(['dispatched', 'completed', 'failed', 'input_required'])
        .optional(),
    parentTurnId: z.string().optional(),
    childAgentNodeId: z.string().optional(),
    childTraceId: z.string().optional(),
    resultSummary: JsonValueSchema.optional(),
    error: JsonValueSchema.optional(),
    module: z.string().optional(),
});
export type ChildCallTrace = z.infer<typeof ChildCallTraceSchema>;

export const TurnTraceSchema = z.object({
    turn: z.number(),
    turnId: z.string(),

    // Manifest provenance
    agentCardSource: ManifestSourceSchema,
    runtimeManifestSource: ManifestSourceSchema,
    agentCardHash: z.string(),
    runtimeManifestHash: z.string(),

    // Stage
    stageBefore: z.string(),
    stageAfter: z.string().optional(),
    stageTransition: z.object({ from: z.string(), to: z.string() }).optional(),
    stageAutoMarksApplied: z.array(z.string()).optional(),
    stageInvariantChecks: z.array(StageInvariantCheckResultSchema).optional(),
    stageInvariantError: InvariantErrorPayloadSchema.optional(),

    // Inbox (compact summary, not raw payloads)
    inboxCurrent: z.array(InboxObservationSummarySchema),

    // Module outputs (compact, not raw)
    attention: JsonValueSchema.optional(),
    perception: PerceptionTraceSchema.optional(),
    mentalStateBeforeHash: z.string().optional(),
    mentalStateAfterHash: z.string().optional(),
    intent: IntentTraceSchema.optional(),
    shield: ShieldTraceSchema.optional(),
    execAction: ExecActionTraceSchema.optional(),
    execResult: ExecResultTraceSchema.optional(),
    transition: TransitionTraceSchema.optional(),

    // Pending state summary (normalized)
    pendingAfter: PendingSummarySchema.optional(),

    // Timing and usage
    timings: TurnTimingsSchema,
    usage: TurnUsageSchema.optional(),

    // Correlation
    correlationId: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),

    // Sub-call summaries (LLM, tool, child calls made during this turn)
    llmCalls: z.array(LLMCallTraceSchema).optional(),
    toolCalls: z.array(ToolCallTraceSchema).optional(),
    childCalls: z.array(ChildCallTraceSchema).optional(),

    // Error (if turn failed)
    error: z
        .object({
            code: z.string().optional(),
            message: z.string(),
            module: FrameworkModuleNameSchema.optional(),
            detail: JsonValueSchema.optional(),
        })
        .optional(),
});

export type TurnTrace = z.infer<typeof TurnTraceSchema>;

// ManifestProvenance (append to same file per doc)
export const ManifestProvenanceSchema = z.object({
    agentCardSource: ManifestSourceSchema,
    runtimeManifestSource: ManifestSourceSchema,
    agentCardHash: z.string(),
    runtimeManifestHash: z.string(),
});
export type ManifestProvenance = z.infer<typeof ManifestProvenanceSchema>;
