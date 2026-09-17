# ADR 0005: execute_step Names a Step; Loop Does Not Schedule

## Status

Accepted

Implementation contract: `specs/execute-step-intent.md`.

## Context

DAG agents can see several ready steps (Phase 2) but core Intent only has
`execute_next_step(planId)`, which is cursor-shaped. The originating
request’s `scheduling` field would have made the **loop** pick among them.

APLRET Policy emits **one intent per turn**. Parallel work is Execution
fan-out (`pending.tools` / `pending.children`), not a Policy array of
steps. Policy arrays are stochastic samples of a single intent.

`execute_step` must be a **Policy-level planning intent**, not a field on
`PlanStep.intent` (ADR 0001: steps store executable effects, not “make
a plan” / “run a step”).

Dispatching `step.intent` without correlating the effect token to the
step leaves the step `pending`. The next Policy turn can fire it again.
Completions carry a token, not a `stepId`. Core must own that loop if
core dispatches.

`execute_next_step` is a stub today. Teaching only `execute_step` to
dispatch would train two Execution stories.

## Decision

- Add `{ kind: 'execute_step', planId, stepId }` to `PlanningIntentSchema`
  and `IntentSchema`. Do **not** add it to `ExecutableStepIntentSchema`.
- Sequential Policy keeps `execute_next_step` + `cursor`. DAG Policy
  emits one `execute_step`. Default Policy stays sequential.
- **Shared dispatcher** for `execute_next_step` (step at `cursor`) and
  `execute_step` (named `stepId`). Same lookup, same errors, same
  pending stamp.
- Execution does **not** walk `dependsOn` and does **not** honor
  `requireValidatedDependencies`. A pending but blocked step **will
  run** if Policy names it. That is a Policy invariant, not an
  Execution gate.
- Execution does **not** write `M`. It stamps `planId`, `stepId`, and
  `advanceCursor` on `pending.tools` / `pending.children` /
  `pending.inputs` when the effect awaits. For continue effects it
  returns `planStepUpdated` in `result.data` (existing Transition path).
- Default Learning maps tool/child/user terminal observations to
  `updateStep` via that stamp, and advances `cursor` only when
  `advanceCursor` is true (`execute_next_step`).
- `execute_step` never advances `cursor`.

## Consequences

- Default DAG and sequential paths both complete a step without custom
  Learning.
- Tests: two ready steps; one executed; after resume Learning, the other
  still pending/ready; first is not still pending.

## Non-Goals

- Do not add `Plan.scheduling`.
- Do not make `cursor` optional.
- Do not run two steps from one Policy turn.
- Do not store `execute_step` on the step.
- Do not check the graph in Execution.
