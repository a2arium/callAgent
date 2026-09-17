import type { ExecutableStepIntent, Intent } from '../types/intent.js';
import type { MentalState } from '../loop/types.js';
import type { Plan } from '../types/plan.js';

export type PlanStepDispatchErrorCode =
    | 'PLAN_NOT_FOUND'
    | 'PLAN_NOT_EXECUTABLE'
    | 'PLAN_STEP_NOT_FOUND'
    | 'PLAN_STEP_NOT_PENDING'
    | 'PLAN_STEP_NO_INTENT';

export type ResolveStoredPlanStepResult =
    | {
        ok: true;
        planId: string;
        stepId: string;
        advanceCursor: boolean;
        intent: ExecutableStepIntent;
        plan: Plan;
    }
    | {
        ok: false;
        errorCode: PlanStepDispatchErrorCode;
        message: string;
    };

const NOT_EXECUTABLE = new Set(['cancelled', 'completed', 'stale']);

export function resolveStoredPlanStep(
    intent: Extract<Intent, { kind: 'execute_step' | 'execute_next_step' }>,
    m: MentalState
): ResolveStoredPlanStepResult {
    const planId = intent.planId;
    const plan = m.plans?.plans?.[planId];
    if (!plan) {
        return { ok: false, errorCode: 'PLAN_NOT_FOUND', message: `Plan '${planId}' was not found` };
    }
    if (NOT_EXECUTABLE.has(plan.status)) {
        return {
            ok: false,
            errorCode: 'PLAN_NOT_EXECUTABLE',
            message: `Plan '${planId}' status '${plan.status}' is not executable`,
        };
    }

    const stepId = intent.kind === 'execute_step'
        ? intent.stepId
        : plan.cursor >= plan.steps.length
            ? undefined
            : plan.steps[plan.cursor]?.id;

    if (stepId === undefined) {
        return {
            ok: false,
            errorCode: 'PLAN_STEP_NOT_FOUND',
            message: `Plan '${planId}' cursor ${plan.cursor} is past the last step`,
        };
    }

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
        return {
            ok: false,
            errorCode: 'PLAN_STEP_NOT_FOUND',
            message: `Step '${stepId}' was not found in plan '${planId}'`,
        };
    }
    if (step.status !== 'pending') {
        return {
            ok: false,
            errorCode: 'PLAN_STEP_NOT_PENDING',
            message: `Step '${stepId}' status '${step.status}' is not pending`,
        };
    }
    if (!step.intent) {
        return {
            ok: false,
            errorCode: 'PLAN_STEP_NO_INTENT',
            message: `Step '${stepId}' has no executable intent`,
        };
    }

    return {
        ok: true,
        planId,
        stepId,
        advanceCursor: intent.kind === 'execute_next_step',
        intent: step.intent,
        plan,
    };
}

/** Named lookup alias of `resolveStoredPlanStep`. Does not run tools. */
export const dispatchStoredPlanStep = resolveStoredPlanStep;
