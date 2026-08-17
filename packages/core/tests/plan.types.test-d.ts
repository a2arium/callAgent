import { expectType, expectError } from 'tsd';
import type { ExecutableStepIntent, Intent } from '../src/types/intent.js';
import type { Plan, PlanJsonValue, PlanStep, PlanStepUpdatedPayload, PlanWithMeta } from '../src/types/plan.js';
import {
    selectReadyPlanSteps,
    validatePlanGraph,
    type PlanGraphLookup,
    type SelectReadyPlanStepsOptions,
    type ValidatePlanGraphResult,
} from '../src/plans/planGraph.js';
import type { PlanPatch, PlanPatchResult } from '../src/plans/planPatch.js';
import { applyPlanPatch } from '../src/plans/planPatch.js';

declare const stepIntent: PlanStep['intent'];
expectType<ExecutableStepIntent | undefined>(stepIntent);

declare function takeStepIntent(intent: PlanStep['intent']): void;
expectError(takeStepIntent({ kind: 'create_plan', goalId: 'g' }));
expectError(takeStepIntent({ kind: 'execute_step', planId: 'p1', stepId: 'A' }));
declare const stepPatch: PlanStepUpdatedPayload;
expectType<boolean | undefined>(stepPatch.advanceCursor);

expectType<Intent>({ kind: 'execute_step', planId: 'p1', stepId: 'A' });

declare const planStatus: Plan['status'];
expectType<'proposed' | 'active' | 'stale' | 'completed' | 'failed' | 'cancelled'>(planStatus);

declare const stepKind: PlanStep['kind'];
expectType<'action' | 'subgoal' | 'internal'>(stepKind);

declare function takeStepKind(kind: PlanStep['kind']): void;
expectError(takeStepKind('call_tool'));

declare const withMeta: PlanWithMeta<{ graphKind: string }>;
declare function readOptionalMeta(p: { meta?: { graphKind?: PlanJsonValue } }): void;
readOptionalMeta(withMeta);

declare const plan: Plan;
expectType<readonly PlanStep[]>(selectReadyPlanSteps(plan));
declare const unknownInput: unknown;
expectType<ValidatePlanGraphResult>(validatePlanGraph(unknownInput));

declare const lookup: PlanGraphLookup<readonly PlanStep[]>;
if (lookup.ok) {
    expectType<readonly PlanStep[]>(lookup.value);
} else {
    expectType<false>(lookup.ok);
}

declare const validated: ValidatePlanGraphResult;
if (validated.ok) {
    expectType<Plan>(validated.plan);
} else {
    expectType<false>(validated.ok);
}

declare const options: SelectReadyPlanStepsOptions;
expectType<boolean | undefined>(options.requireValidatedDependencies);
expectType<readonly PlanStep[]>(selectReadyPlanSteps(plan, options));
expectError(selectReadyPlanSteps(plan, { extra: true }));

declare const patchOp: PlanPatch['operations'][number]['op'];
expectType<'add_step' | 'remove_step' | 'update_step' | 'add_dependency' | 'remove_dependency' | 'set_cursor'>(patchOp);

declare const applied: PlanPatchResult;
if (applied.ok) {
    expectType<Plan>(applied.plan);
} else {
    expectType<false>(applied.ok);
}
expectType<PlanPatchResult>(applyPlanPatch(plan, { baseRevision: 0, operations: [{ op: 'set_cursor', cursor: 0 }] }));
