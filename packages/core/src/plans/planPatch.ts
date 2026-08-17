import { z } from 'zod';
import {
    PlanStepObjectSchema,
    PlanStepSchema,
    collectPlanGraphIssues,
    type Plan,
    type PlanStep,
} from '../types/plan.js';
import {
    PlanGraphIssueSchema,
    type PlanGraphIssue,
} from './planGraph.js';

export const PlanPatchOpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('add_step'), step: PlanStepSchema }).strict(),
    z.object({ op: z.literal('remove_step'), stepId: z.string().min(1) }).strict(),
    z.object({
        op: z.literal('update_step'),
        stepId: z.string().min(1),
        patch: PlanStepObjectSchema.partial().omit({ id: true }),
    }).strict(),
    z.object({
        op: z.literal('add_dependency'),
        stepId: z.string().min(1),
        dependsOn: z.string().min(1),
    }).strict(),
    z.object({
        op: z.literal('remove_dependency'),
        stepId: z.string().min(1),
        dependsOn: z.string().min(1),
    }).strict(),
    z.object({
        op: z.literal('set_cursor'),
        cursor: z.number().int().nonnegative(),
    }).strict(),
]);

export const PlanPatchSchema = z.object({
    baseRevision: z.number().int().nonnegative(),
    operations: z.array(PlanPatchOpSchema).min(1),
}).strict();

export type PlanPatchOp = z.infer<typeof PlanPatchOpSchema>;
export type PlanPatch = z.infer<typeof PlanPatchSchema>;

export type PlanPatchResult =
    | { ok: true; plan: Plan }
    | { ok: false; errors: PlanGraphIssue[] };

export const PlanPatchPayloadSchema = z.object({
    planId: z.string().min(1),
    patch: PlanPatchSchema,
}).strict();
export type PlanPatchPayload = z.infer<typeof PlanPatchPayloadSchema>;

export const PlanGraphDiffSchema = z.object({
    addedSteps: z.array(z.string().min(1)),
    removedSteps: z.array(z.string().min(1)),
    changedSteps: z.array(z.string().min(1)),
    addedDependencies: z.array(z.object({
        stepId: z.string().min(1),
        dependsOn: z.string().min(1),
    }).strict()),
    removedDependencies: z.array(z.object({
        stepId: z.string().min(1),
        dependsOn: z.string().min(1),
    }).strict()),
}).strict();
export type PlanGraphDiff = z.infer<typeof PlanGraphDiffSchema>;

const issue = (
    errorCode: PlanGraphIssue['errorCode'],
    message: string,
    extra?: { path?: Array<string | number>; stepId?: string }
): PlanGraphIssue =>
    PlanGraphIssueSchema.parse({ errorCode, message, ...extra });

const cloneSteps = (steps: readonly PlanStep[]): PlanStep[] =>
    steps.map((step) => ({
        ...step,
        dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
        outputs: step.outputs ? step.outputs.map((o) => ({ ...o })) : undefined,
    }));

const fail = (errors: PlanGraphIssue[]): PlanPatchResult => ({ ok: false, errors });

export function applyPlanPatch(plan: Plan, patch: PlanPatch): PlanPatchResult {
    if (patch.baseRevision !== plan.revision) {
        return fail([
            issue(
                'PLAN_PATCH_REVISION_MISMATCH',
                `Patch baseRevision ${patch.baseRevision} does not match plan revision ${plan.revision}`
            ),
        ]);
    }

    const steps = cloneSteps(plan.steps);
    let cursor = plan.cursor;
    let hadSetCursor = false;

    const indexOf = (stepId: string): number => steps.findIndex((s) => s.id === stepId);

    for (const op of patch.operations) {
        if (op.op === 'add_step') {
            if (indexOf(op.step.id) >= 0) {
                return fail([
                    issue('PLAN_DUPLICATE_STEP_ID', `Duplicate step id '${op.step.id}'`, { stepId: op.step.id }),
                ]);
            }
            steps.push(op.step);
            continue;
        }
        if (op.op === 'remove_step') {
            const idx = indexOf(op.stepId);
            if (idx < 0) {
                return fail([issue('PLAN_STEP_NOT_FOUND', `Step '${op.stepId}' was not found`, { stepId: op.stepId })]);
            }
            steps.splice(idx, 1);
            for (let i = 0; i < steps.length; i++) {
                const deps = steps[i].dependsOn;
                if (!deps || deps.length === 0) continue;
                const nextDeps = deps.filter((d) => d !== op.stepId);
                steps[i] = { ...steps[i], dependsOn: nextDeps.length > 0 ? nextDeps : undefined };
            }
            continue;
        }
        if (op.op === 'update_step') {
            const idx = indexOf(op.stepId);
            if (idx < 0) {
                return fail([issue('PLAN_STEP_NOT_FOUND', `Step '${op.stepId}' was not found`, { stepId: op.stepId })]);
            }
            steps[idx] = { ...steps[idx], ...op.patch, id: steps[idx].id };
            continue;
        }
        if (op.op === 'add_dependency') {
            const idx = indexOf(op.stepId);
            if (idx < 0) {
                return fail([issue('PLAN_STEP_NOT_FOUND', `Step '${op.stepId}' was not found`, { stepId: op.stepId })]);
            }
            if (op.dependsOn === op.stepId) {
                return fail([
                    issue('PLAN_DEPENDENCY_SELF', `Step '${op.stepId}' depends on itself`, { stepId: op.stepId }),
                ]);
            }
            if (indexOf(op.dependsOn) < 0) {
                return fail([
                    issue(
                        'PLAN_DEPENDENCY_MISSING',
                        `Dependency '${op.dependsOn}' is missing`,
                        { stepId: op.stepId }
                    ),
                ]);
            }
            const deps = steps[idx].dependsOn ?? [];
            steps[idx] = { ...steps[idx], dependsOn: [...new Set([...deps, op.dependsOn])] };
            continue;
        }
        if (op.op === 'remove_dependency') {
            const idx = indexOf(op.stepId);
            if (idx < 0) {
                return fail([issue('PLAN_STEP_NOT_FOUND', `Step '${op.stepId}' was not found`, { stepId: op.stepId })]);
            }
            const deps = steps[idx].dependsOn ?? [];
            const nextDeps = deps.filter((d) => d !== op.dependsOn);
            steps[idx] = { ...steps[idx], dependsOn: nextDeps.length > 0 ? nextDeps : undefined };
            continue;
        }
        hadSetCursor = true;
        cursor = op.cursor;
    }

    if (hadSetCursor && cursor > steps.length) {
        return fail([
            issue(
                'PLAN_CURSOR_OUT_OF_BOUNDS',
                `Explicit cursor ${cursor} is past steps.length ${steps.length}`
            ),
        ]);
    }
    if (cursor > steps.length) {
        cursor = steps.length;
    }

    const next: Plan = { ...plan, steps, cursor };
    const graphIssues = collectPlanGraphIssues(next).map((draft) =>
        PlanGraphIssueSchema.parse({
            errorCode: draft.errorCode,
            message: draft.message,
            path: draft.path,
            stepId: draft.stepId,
        })
    );
    if (graphIssues.length > 0) {
        return fail(graphIssues);
    }
    return { ok: true, plan: next };
}

export function validatePlanPatch(plan: Plan, patch: unknown): PlanPatchResult {
    try {
        const parsed = PlanPatchSchema.safeParse(patch);
        if (!parsed.success) {
            return fail([
                issue(
                    'PLAN_PATCH_INVALID',
                    parsed.error.issues[0]?.message || 'Invalid plan patch'
                ),
            ]);
        }
        return applyPlanPatch(plan, parsed.data);
    } catch (err) {
        return fail([
            issue('PLAN_PATCH_INVALID', err instanceof Error ? err.message : 'Invalid plan patch'),
        ]);
    }
}

const edgeKey = (stepId: string, dependsOn: string): string => `${stepId}\0${dependsOn}`;

const edgeSet = (plan: Plan): Map<string, { stepId: string; dependsOn: string }> => {
    const edges = new Map<string, { stepId: string; dependsOn: string }>();
    for (const step of plan.steps) {
        for (const dep of step.dependsOn ?? []) {
            edges.set(edgeKey(step.id, dep), { stepId: step.id, dependsOn: dep });
        }
    }
    return edges;
};

const stableEdges = (edges: Array<{ stepId: string; dependsOn: string }>): Array<{ stepId: string; dependsOn: string }> =>
    [...edges].sort((a, b) => a.stepId.localeCompare(b.stepId) || a.dependsOn.localeCompare(b.dependsOn));

export function diffPlanGraph(before: Plan, after: Plan): PlanGraphDiff {
    const beforeIds = new Set(before.steps.map((s) => s.id));
    const afterIds = new Set(after.steps.map((s) => s.id));
    const addedSteps = after.steps.filter((s) => !beforeIds.has(s.id)).map((s) => s.id);
    const removedSteps = before.steps.filter((s) => !afterIds.has(s.id)).map((s) => s.id);
    const beforeById = new Map(before.steps.map((s) => [s.id, s]));
    const changedSteps = after.steps
        .filter((s) => {
            const prev = beforeById.get(s.id);
            return prev !== undefined && JSON.stringify(prev) !== JSON.stringify(s);
        })
        .map((s) => s.id);

    const beforeEdges = edgeSet(before);
    const afterEdges = edgeSet(after);
    const addedDependencies: Array<{ stepId: string; dependsOn: string }> = [];
    const removedDependencies: Array<{ stepId: string; dependsOn: string }> = [];
    for (const [key, edge] of afterEdges) {
        if (!beforeEdges.has(key)) addedDependencies.push(edge);
    }
    for (const [key, edge] of beforeEdges) {
        if (!afterEdges.has(key)) removedDependencies.push(edge);
    }

    return PlanGraphDiffSchema.parse({
        addedSteps,
        removedSteps,
        changedSteps,
        addedDependencies: stableEdges(addedDependencies),
        removedDependencies: stableEdges(removedDependencies),
    });
}
