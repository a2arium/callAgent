# ADR 0004: Validation Is Cognition; Lineage Explains Revision

## Status

Accepted

Implementation contract: `specs/plan-validation-and-lineage.md`.

## Context

The originating request distinguished “step completed” from “downstream
may use this result,” and wanted optional revision lineage (`parentRevision`,
cause, evidence refs).

APLRET already validates LLM/tool/child payloads before Learning writes.
That Perception/Learning schema check is **not** the same as “this step’s
work is downstream-usable.” Mixing them would make `PlanSchema.parse`
depend on agent-specific evaluators.

`revision: number` is already monotonic by contract, not by Zod-across-turns.
Lineage should explain a bump, not replace it.

Phase 2 readiness is `completed` only. A validation gate must be **opt-in**
so simple agents do not break.

`MentalState.extensions` was requested as a typed bag for evaluator state.
That is rejected (ADR 0001): use plan/step `meta` or `worldModel`.

## Decision

- Optional `validation?: ValidationState` on `PlanStep`. Learning-owned.
- Closed status: `unknown | pending | valid | invalid`. Optional `refs`.
- This is **not** Perception’s `PlanSchema` check and not a control-stage
  flag.
- `selectReadyPlanSteps(plan)` stays Phase 2 (`completed` deps).
- Optional second argument `{ requireValidatedDependencies?: boolean }`.
  When true, a dep is satisfied iff `completed` **and**
  `validation?.status === 'valid'`. Absent / `unknown` / `pending` /
  `invalid` do not satisfy.
- Do not add a second public name `selectRunnablePlanSteps`.
- Optional `lineage?: PlanRevisionLineage` on `Plan`. When
  `parentRevision` is set, it MUST be `< revision`.
- Do not add `MentalState.extensions`.

## Consequences

- Simple agents omit `validation` and keep Phase 2 helpers.
- DAG agents that need a quality gate pass the flag from Policy (still
  M-only, still one intent).
- Repair attribution uses `lineage`; the patch API is Phase 6.

## Non-Goals

- Do not require validation on every step.
- Do not run evaluators in Policy or Perception.
- Do not encode ATG scoring in `ValidationState`.
