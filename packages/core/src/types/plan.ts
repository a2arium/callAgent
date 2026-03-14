import { z } from 'zod';
import { IntentSchema } from './intent.js';

export const PlanIdSchema = z.string().describe('Unique identifier for a plan');
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PlanStatusSchema = z.enum(['proposed', 'active', 'completed', 'failed', 'cancelled']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepKindSchema = z.enum(['action', 'subgoal', 'internal']);
export type StepKind = z.infer<typeof StepKindSchema>;

export const PlanStepSchema = z.object({
    id: z.string(),
    kind: StepKindSchema,
    goalId: z.string().optional(),
    description: z.string(),
    status: StepStatusSchema.default('pending'),
    intent: IntentSchema.optional().describe('The intent to execute for this step'),
    result: z.unknown().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
    id: PlanIdSchema,
    goalId: z.string().optional().describe('The goal this plan aims to achieve'),
    steps: z.array(PlanStepSchema),
    cursor: z.number().int().nonnegative().default(0),
    status: PlanStatusSchema.default('proposed'),
    revision: z.number().int().nonnegative().default(0),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
}).refine(
    (data) => data.cursor <= data.steps.length,
    { message: 'Cursor cannot exceed number of steps', path: ['cursor'] }
);
export type Plan = z.infer<typeof PlanSchema>;

export const PlanStateSchema = z.object({
    plans: z.record(PlanIdSchema, PlanSchema),
    activePlanId: PlanIdSchema.optional(),
});
export type PlanState = z.infer<typeof PlanStateSchema>;
