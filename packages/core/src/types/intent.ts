import { z } from 'zod';

export const PromptUserIntentSchema = z.object({
    kind: z.literal('prompt_user'),
    prompt: z.string(),
    schema: z.unknown().optional(),
});

export const AnswerWithLlmIntentSchema = z.object({
    kind: z.literal('answer_with_llm'),
    query: z.string(),
    contextKey: z.string().optional(),
});

export const CallToolIntentSchema = z.object({
    kind: z.literal('call_tool'),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    mode: z.enum(['sync', 'async']).optional(),
});

export const DelegateToChildIntentSchema = z.object({
    kind: z.literal('delegate_to_child'),
    agentId: z.string(),
    input: z.unknown(),
});

export const CompleteIntentSchema = z.object({
    kind: z.literal('complete'),
    result: z.unknown().optional(),
});

export const WaitIntentSchema = z.object({
    kind: z.literal('wait'),
});

export const InternalIntentSchema = z.object({
    kind: z.literal('internal'),
    intent: z.string(),
    data: z.unknown().optional(),
});

export const CreatePlanIntentSchema = z.object({
    kind: z.literal('create_plan'),
    goalId: z.string(),
});

export const ExecuteNextStepIntentSchema = z.object({
    kind: z.literal('execute_next_step'),
    planId: z.string(),
});

export const RepairPlanIntentSchema = z.object({
    kind: z.literal('repair_plan'),
    planId: z.string(),
    reason: z.string(),
});

export const ExecuteStepIntentSchema = z.object({
    kind: z.literal('execute_step'),
    planId: z.string().min(1),
    stepId: z.string().min(1),
}).strict();

export const ExecutableStepIntentSchema = z.discriminatedUnion('kind', [
    PromptUserIntentSchema,
    AnswerWithLlmIntentSchema,
    CallToolIntentSchema,
    DelegateToChildIntentSchema,
    CompleteIntentSchema,
    WaitIntentSchema,
    InternalIntentSchema,
]);

export const PlanningIntentSchema = z.discriminatedUnion('kind', [
    CreatePlanIntentSchema,
    ExecuteNextStepIntentSchema,
    ExecuteStepIntentSchema,
    RepairPlanIntentSchema,
]);

export const IntentSchema = z.discriminatedUnion('kind', [
    PromptUserIntentSchema,
    AnswerWithLlmIntentSchema,
    CallToolIntentSchema,
    DelegateToChildIntentSchema,
    CreatePlanIntentSchema,
    ExecuteNextStepIntentSchema,
    ExecuteStepIntentSchema,
    RepairPlanIntentSchema,
    CompleteIntentSchema,
    WaitIntentSchema,
    InternalIntentSchema,
]);

export type Intent = z.infer<typeof IntentSchema>;
export type ExecutableStepIntent = z.infer<typeof ExecutableStepIntentSchema>;
export type PlanningIntent = z.infer<typeof PlanningIntentSchema>;

export const ExecutableActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prompt_user'), token: z.string() }),
    z.object({ kind: z.literal('delegate_to_child'), token: z.string().optional() }),
    z.object({ kind: z.literal('call_tool'), token: z.string().optional() }),
    z.object({ kind: z.literal('answer_with_llm'), echoed: z.boolean() }),
    z.object({ kind: z.literal('internal'), done: z.boolean() }),
]);

export type ExecutableAction = z.infer<typeof ExecutableActionSchema>;
