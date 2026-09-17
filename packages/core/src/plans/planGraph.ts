import { z } from 'zod';
import { PlanSchema, type Plan, type PlanStep } from '../types/plan.js';

export const PlanGraphErrorCodeSchema = z.enum([
    'PLAN_DUPLICATE_STEP_ID',
    'PLAN_DEPENDENCY_MISSING',
    'PLAN_DEPENDENCY_SELF',
    'PLAN_DEPENDENCY_CYCLE',
    'PLAN_CURSOR_OUT_OF_BOUNDS',
    'PLAN_SCHEMA_INVALID',
    'PLAN_STEP_NOT_FOUND',
    'PLAN_PATCH_REVISION_MISMATCH',
    'PLAN_PATCH_INVALID',
]);
export type PlanGraphErrorCode = z.infer<typeof PlanGraphErrorCodeSchema>;

export const PlanGraphIssueSchema = z
    .object({
        errorCode: PlanGraphErrorCodeSchema,
        message: z.string().min(1),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        stepId: z.string().min(1).optional(),
    })
    .strict();
export type PlanGraphIssue = z.infer<typeof PlanGraphIssueSchema>;

export type ValidatePlanGraphResult =
    | { ok: true; plan: Plan }
    | { ok: false; errors: PlanGraphIssue[] };

export type PlanGraphLookup<T> =
    | { ok: true; value: T }
    | { ok: false; errors: PlanGraphIssue[] };

const GRAPH_CODES_FROM_PARSE = new Set<PlanGraphErrorCode>([
    'PLAN_DUPLICATE_STEP_ID',
    'PLAN_DEPENDENCY_MISSING',
    'PLAN_DEPENDENCY_SELF',
    'PLAN_DEPENDENCY_CYCLE',
    'PLAN_CURSOR_OUT_OF_BOUNDS',
]);

const uniquifyIds = (ids: readonly string[] | undefined): string[] =>
    ids === undefined ? [] : [...new Set(ids)];

const zodIssueParams = (issue: z.ZodIssue): Record<string, unknown> | undefined => {
    if (!('params' in issue)) return undefined;
    const params = issue.params;
    if (params === undefined || typeof params !== 'object' || params === null) return undefined;
    return params as Record<string, unknown>;
};

const issueFromZod = (issue: z.ZodIssue): PlanGraphIssue => {
    const params = zodIssueParams(issue);
    const rawCode =
        issue.code === 'custom' &&
        params !== undefined &&
        typeof params.errorCode === 'string'
            ? params.errorCode
            : undefined;
    const parsedCode = PlanGraphErrorCodeSchema.safeParse(rawCode);
    const errorCode =
        parsedCode.success && GRAPH_CODES_FROM_PARSE.has(parsedCode.data)
            ? parsedCode.data
            : 'PLAN_SCHEMA_INVALID';
    const stepIdRaw =
        params !== undefined && typeof params.stepId === 'string'
            ? params.stepId
            : undefined;
    return PlanGraphIssueSchema.parse({
        errorCode,
        message: issue.message.length > 0 ? issue.message : 'Invalid plan',
        path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        stepId: stepIdRaw !== undefined && stepIdRaw.length > 0 ? stepIdRaw : undefined,
    });
};

export function validatePlanGraph(input: unknown): ValidatePlanGraphResult {
    const parsed = PlanSchema.safeParse(input);
    if (parsed.success) {
        return { ok: true, plan: parsed.data };
    }
    const errors = parsed.error.issues.map(issueFromZod);
    return { ok: false, errors: errors.length > 0 ? errors : [{ errorCode: 'PLAN_SCHEMA_INVALID', message: 'Invalid plan' }] };
}

const stepById = (plan: Plan): Map<string, PlanStep> => {
    const map = new Map<string, PlanStep>();
    for (const step of plan.steps) {
        if (!map.has(step.id)) map.set(step.id, step);
    }
    return map;
};

export const SelectReadyPlanStepsOptionsSchema = z
    .object({
        requireValidatedDependencies: z.boolean().optional(),
    })
    .strict();
export type SelectReadyPlanStepsOptions = z.infer<typeof SelectReadyPlanStepsOptionsSchema>;

const isSatisfied = (plan: Plan, depId: string, options?: SelectReadyPlanStepsOptions): boolean => {
    const dep = plan.steps.find((s) => s.id === depId);
    if (dep?.status !== 'completed') return false;
    if (options?.requireValidatedDependencies === true) {
        return dep.validation?.status === 'valid';
    }
    return true;
};

const isReadyPending = (plan: Plan, step: PlanStep, options?: SelectReadyPlanStepsOptions): boolean => {
    if (step.status !== 'pending') return false;
    return uniquifyIds(step.dependsOn).every((depId) => isSatisfied(plan, depId, options));
};

export function selectReadyPlanSteps(plan: Plan, options?: SelectReadyPlanStepsOptions): readonly PlanStep[] {
    return plan.steps.filter((step) => isReadyPending(plan, step, options));
}

export function selectBlockedPlanSteps(plan: Plan, options?: SelectReadyPlanStepsOptions): readonly PlanStep[] {
    return plan.steps.filter((step) => step.status === 'pending' && !isReadyPending(plan, step, options));
}

const missingStep = (stepId: string): PlanGraphLookup<readonly PlanStep[]> => ({
    ok: false,
    errors: [
        PlanGraphIssueSchema.parse({
            errorCode: 'PLAN_STEP_NOT_FOUND',
            message: stepId.length > 0 ? `Step '${stepId}' was not found` : 'Step was not found',
            stepId: stepId.length > 0 ? stepId : undefined,
        }),
    ],
});

const inStepsOrder = (plan: Plan, ids: ReadonlySet<string>): PlanStep[] =>
    plan.steps.filter((step) => ids.has(step.id));

export function getPlanDependants(plan: Plan, stepId: string): PlanGraphLookup<readonly PlanStep[]> {
    if (!plan.steps.some((s) => s.id === stepId)) return missingStep(stepId);
    const ids = new Set<string>();
    for (const step of plan.steps) {
        if (step.id === stepId) continue;
        if (uniquifyIds(step.dependsOn).includes(stepId)) ids.add(step.id);
    }
    return { ok: true, value: inStepsOrder(plan, ids) };
}

export function getPlanAncestors(plan: Plan, stepId: string): PlanGraphLookup<readonly PlanStep[]> {
    const byId = stepById(plan);
    if (!byId.has(stepId)) return missingStep(stepId);
    const visited = new Set<string>();
    const walk = (id: string): void => {
        const step = byId.get(id);
        if (!step) return;
        for (const dep of uniquifyIds(step.dependsOn)) {
            if (visited.has(dep) || dep === stepId) continue;
            visited.add(dep);
            walk(dep);
        }
    };
    walk(stepId);
    visited.delete(stepId);
    return { ok: true, value: inStepsOrder(plan, visited) };
}

export function getPlanDescendants(plan: Plan, stepId: string): PlanGraphLookup<readonly PlanStep[]> {
    if (!plan.steps.some((s) => s.id === stepId)) return missingStep(stepId);
    const children = new Map<string, string[]>();
    for (const step of plan.steps) {
        for (const dep of uniquifyIds(step.dependsOn)) {
            const list = children.get(dep) ?? [];
            list.push(step.id);
            children.set(dep, list);
        }
    }
    const visited = new Set<string>();
    const walk = (id: string): void => {
        for (const child of children.get(id) ?? []) {
            if (visited.has(child) || child === stepId) continue;
            visited.add(child);
            walk(child);
        }
    };
    walk(stepId);
    visited.delete(stepId);
    return { ok: true, value: inStepsOrder(plan, visited) };
}
