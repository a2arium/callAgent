import { z } from 'zod';
import { ExecutableStepIntentSchema } from './intent.js';

export const PlanIdSchema = z.string().min(1).describe('Unique identifier for a plan');
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PlanStatusSchema = z.enum([
    'proposed',
    'active',
    'stale',
    'completed',
    'failed',
    'cancelled',
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepKindSchema = z.enum(['action', 'subgoal', 'internal']);
export type StepKind = z.infer<typeof StepKindSchema>;

export type PlanJsonValue =
    | string
    | number
    | boolean
    | null
    | PlanJsonValue[]
    | { [key: string]: PlanJsonValue };

export const PlanJsonValueSchema: z.ZodType<PlanJsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(PlanJsonValueSchema),
        z.record(z.string(), PlanJsonValueSchema),
    ])
);

export const PlanMetaSchema = z.record(z.string(), PlanJsonValueSchema);

const uniquifyIds = (ids: string[] | undefined): string[] | undefined => {
    if (ids === undefined) return undefined;
    return [...new Set(ids)];
};

type PlanGraphIssueCode =
    | 'PLAN_DUPLICATE_STEP_ID'
    | 'PLAN_DEPENDENCY_MISSING'
    | 'PLAN_DEPENDENCY_SELF'
    | 'PLAN_DEPENDENCY_CYCLE'
    | 'PLAN_CURSOR_OUT_OF_BOUNDS';

type PlanGraphIssueDraft = {
    errorCode: PlanGraphIssueCode;
    message: string;
    path: Array<string | number>;
    stepId?: string;
};

type PlanGraphInput = {
    steps: Array<{ id: string; dependsOn?: string[] }>;
    cursor: number;
};

/**
 * File-local graph walk shared with Phase 2 `validatePlanGraph`.
 * Not a public `@a2arium/callagent-core` export.
 */
export function collectPlanGraphIssues(plan: PlanGraphInput): PlanGraphIssueDraft[] {
    const issues: PlanGraphIssueDraft[] = [];
    const idToIndex = new Map<string, number>();

    for (let i = 0; i < plan.steps.length; i++) {
        const stepId = plan.steps[i].id;
        if (idToIndex.has(stepId)) {
            issues.push({
                errorCode: 'PLAN_DUPLICATE_STEP_ID',
                message: `Duplicate step id '${stepId}'`,
                path: ['steps', i, 'id'],
                stepId,
            });
        } else {
            idToIndex.set(stepId, i);
        }
    }

    const adj = new Map<string, string[]>();
    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const deps = uniquifyIds(step.dependsOn) ?? [];
        const neighbors: string[] = [];
        for (const dep of deps) {
            if (dep === step.id) {
                issues.push({
                    errorCode: 'PLAN_DEPENDENCY_SELF',
                    message: `Step '${step.id}' depends on itself`,
                    path: ['steps', i, 'dependsOn'],
                    stepId: step.id,
                });
                continue;
            }
            if (!idToIndex.has(dep)) {
                issues.push({
                    errorCode: 'PLAN_DEPENDENCY_MISSING',
                    message: `Step '${step.id}' depends on missing id '${dep}'`,
                    path: ['steps', i, 'dependsOn'],
                    stepId: step.id,
                });
                continue;
            }
            neighbors.push(dep);
        }
        adj.set(step.id, neighbors);
    }

    const color = new Map<string, 0 | 1 | 2>();
    const visit = (id: string): boolean => {
        color.set(id, 1);
        for (const next of adj.get(id) ?? []) {
            const c = color.get(next) ?? 0;
            if (c === 1) return true;
            if (c === 0 && visit(next)) return true;
        }
        color.set(id, 2);
        return false;
    };

    for (const step of plan.steps) {
        if ((color.get(step.id) ?? 0) === 0 && visit(step.id)) {
            issues.push({
                errorCode: 'PLAN_DEPENDENCY_CYCLE',
                message: `Plan has a cycle in dependsOn involving '${step.id}'`,
                path: ['steps'],
                stepId: step.id,
            });
            break;
        }
    }

    if (plan.cursor > plan.steps.length) {
        issues.push({
            errorCode: 'PLAN_CURSOR_OUT_OF_BOUNDS',
            message: `Cursor ${plan.cursor} exceeds steps.length ${plan.steps.length}`,
            path: ['cursor'],
        });
    }

    return issues;
}

const addPlanGraphIssues = (plan: PlanGraphInput, ctx: z.RefinementCtx): void => {
    for (const issue of collectPlanGraphIssues(plan)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: issue.message,
            path: issue.path,
            params: { errorCode: issue.errorCode, stepId: issue.stepId },
        });
    }
};

export const PlanOutputKindSchema = z.enum(['artifact', 'memory', 'evidence']);
export type PlanOutputKind = z.infer<typeof PlanOutputKindSchema>;

export const PlanOutputRefSchema = z
    .object({
        name: z.string().min(1).optional(),
        kind: PlanOutputKindSchema,
        ref: z.string().min(1),
    })
    .strict();
export type PlanOutputRef = z.infer<typeof PlanOutputRefSchema>;

export const ValidationStatusSchema = z.enum(['unknown', 'pending', 'valid', 'invalid']);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const ValidationStateSchema = z
    .object({
        status: ValidationStatusSchema,
        refs: z.array(z.string().min(1)).optional().transform(uniquifyIds),
    })
    .strict();
export type ValidationState = z.infer<typeof ValidationStateSchema>;

export const PlanRevisionCauseKindSchema = z.enum([
    'initial',
    'observation',
    'failure',
    'user_change',
    'optimization',
    'manual',
]);
export type PlanRevisionCauseKind = z.infer<typeof PlanRevisionCauseKindSchema>;

export const PlanRevisionCauseSchema = z
    .object({
        kind: PlanRevisionCauseKindSchema,
        ref: z.string().min(1).optional(),
    })
    .strict();
export type PlanRevisionCause = z.infer<typeof PlanRevisionCauseSchema>;

export const PlanRevisionLineageSchema = z
    .object({
        parentRevision: z.number().int().nonnegative().optional(),
        cause: PlanRevisionCauseSchema.optional(),
        evidenceRefs: z.array(z.string().min(1)).optional(),
    })
    .strict();
export type PlanRevisionLineage = z.infer<typeof PlanRevisionLineageSchema>;

export const PlanStepObjectSchema = z
    .object({
        id: z.string().min(1),
        kind: StepKindSchema,
        goalId: z.string().min(1).optional(),
        title: z.string().min(1),
        status: StepStatusSchema.default('pending'),
        intent: ExecutableStepIntentSchema.optional(),
        dependsOn: z.array(z.string().min(1)).optional().transform(uniquifyIds),
        outputs: z.array(PlanOutputRefSchema).optional(),
        validation: ValidationStateSchema.optional(),
        meta: PlanMetaSchema.optional(),
    })
    .strict();

export const PlanStepSchema = PlanStepObjectSchema.superRefine((step, ctx) => {
    const names = (step.outputs ?? [])
        .map((o) => o.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate output name '${name}'`,
                path: ['outputs'],
                params: { errorCode: 'PLAN_OUTPUT_NAME_DUPLICATE' },
            });
            return;
        }
        seen.add(name);
    }
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z
    .object({
        id: PlanIdSchema,
        goalId: z.string().min(1).optional(),
        steps: z.array(PlanStepSchema),
        cursor: z.number().int().nonnegative().default(0),
        status: PlanStatusSchema.default('proposed'),
        revision: z.number().int().nonnegative().default(0),
        lineage: PlanRevisionLineageSchema.optional(),
        meta: PlanMetaSchema.optional(),
        createdAt: z.string().datetime({ offset: true }).optional(),
        updatedAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        addPlanGraphIssues(data, ctx);
        const parent = data.lineage?.parentRevision;
        if (parent !== undefined && parent >= data.revision) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `lineage.parentRevision ${parent} must be < revision ${data.revision}`,
                path: ['lineage', 'parentRevision'],
                params: { errorCode: 'PLAN_LINEAGE_PARENT' },
            });
        }
    });
export type Plan = z.infer<typeof PlanSchema>;

export const PlanStateSchema = z
    .object({
        plans: z.record(PlanIdSchema, PlanSchema),
        activePlanId: PlanIdSchema.optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (data.activePlanId !== undefined && !(data.activePlanId in data.plans)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `activePlanId '${data.activePlanId}' is not a key in plans`,
                path: ['activePlanId'],
                params: { errorCode: 'PLAN_ACTIVE_ID_MISSING' },
            });
        }
    });
export type PlanState = z.infer<typeof PlanStateSchema>;

export const PlanStepUpdatedPayloadSchema = z
    .object({
        planId: PlanIdSchema,
        stepId: z.string().min(1),
        patch: PlanStepObjectSchema.partial().omit({ id: true }),
        advanceCursor: z.boolean().optional(),
    })
    .strict();
export type PlanStepUpdatedPayload = z.infer<typeof PlanStepUpdatedPayloadSchema>;

export type PlanStepWithMeta<
    StepMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
> = Omit<PlanStep, 'meta'> & { meta?: StepMeta };

export type PlanWithMeta<
    StepMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
    PlanMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
> = Omit<Plan, 'meta' | 'steps'> & {
    meta?: PlanMeta;
    steps: PlanStepWithMeta<StepMeta>[];
};
