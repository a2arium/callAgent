# ADR 0002: Graph Helpers Ignore Cursor

## Status

Accepted

Implementation contract: `specs/plan-graph-helpers.md`.

## Context

The originating request wanted a `PlanScheduling` field (`sequential` vs
`dependencies`) and an optional `cursor`. That would make the loop look like
a DAG scheduler and would split Plan into two runtime modes.

APLRET already has:

- sequential progress via `cursor` + `execute_next_step` (Policy);
- one intent per turn;
- Learning as the only writer of `M.plans`.

`dependsOn` is stored on steps (ADR 0001). Readiness can be derived from
that graph without a new Plan field and without the loop calling a scheduler.

If helpers also honored `cursor`, a DAG plan would hide ready siblings. If
helpers treated “no `dependsOn` anywhere” as sequential, a single accidental
edge would flip the whole plan’s semantics (hidden scheduling mode).

## Decision

- Do **not** add `scheduling` on `Plan`.
- Do **not** make `cursor` optional.
- `selectReadyPlanSteps` / `selectBlockedPlanSteps` read **only**
  `dependsOn` and step `status`. They **ignore** `cursor` and `plan.status`.
- Sequential agents keep using `plan.steps[plan.cursor]` and
  `execute_next_step`. They SHOULD NOT call the ready helper to pick the next
  step.
- DAG agents call the helpers and, from Phase 4, emit `execute_step`. Phase 2
  does not add that intent.
- A dependency is satisfied only when that step is `completed`. `skipped`,
  `failed`, `running`, and `pending` do not satisfy downstream.
- A cursor-only plan (no `dependsOn` on any step) has every **pending** step
  ready according to the helper. That is the DAG reading of “no edges,” not a
  bug. Sequential Policy simply does not use the helper.
- Do not infer a hidden sequential mode from “no `dependsOn` anywhere.”

## Consequences

- One Plan type serves both styles.
- Multiple pending steps can be ready at once; Policy still emits one intent.
- `8-spec_goals_and_plans_in_aplret.md` must stop saying Policy relies
  *solely* on `cursor`. Sequential: cursor. DAG: helpers over `M.plans`.
- Repair uses descendant queries; Learning still applies status patches.

## Non-Goals

- Do not run more than one step per turn from these helpers.
- Do not fan out from Policy.
- Do not add `requireValidatedDependencies` until Phase 3 exists on the schema.
