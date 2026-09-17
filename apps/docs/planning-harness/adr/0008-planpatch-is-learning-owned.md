# ADR 0008: PlanPatch Is Applied Only by Learning

## Status

Accepted

Implementation contract: `specs/plan-patch.md`.

## Context

The originating request wanted a structured `PlanPatch` (add/remove/update
step, add/remove dependency) plus `validatePlanPatch` / `applyPlanPatch`
/ `diffPlanGraph`, so repair is not a blob replace of the whole plan.

APLRET already has `repair_plan` as a Policy intent and
`internal/plan.updated` / `plan.step.updated` as the write path. The
patch must not let Policy or Execution write `M.plans`.

LLM-generated patches are **effects**: Execution produces a candidate,
Transition emits an observation, Perception validates, Learning applies.

## Decision

- Closed Zod `PlanPatch` with `baseRevision` + `operations`.
- Pure `validatePlanPatch` / `applyPlanPatch` / `diffPlanGraph` in
  `packages/core/src/plans/` (next to graph helpers). Result types, no
  unstructured throws.
- `applyPlanPatch` returns a new `Plan`; it does not call
  `MemoryWriter`. Learning applies the result via `writer.plans.set` /
  `update` after `PlanSchema.safeParse`.
- `baseRevision` MUST equal `plan.revision` or the apply fails
  (`PLAN_PATCH_REVISION_MISMATCH`). Learning then bumps `revision` and
  MAY set `lineage` (Phase 3b).
- After graph ops, **clamp** `cursor` to `0..steps.length` unless the
  patch set it explicitly via `set_cursor`. Sequential repair that
  shortens `steps` must not fail `PLAN_CURSOR_OUT_OF_BOUNDS`.
- Optional `set_cursor` op for Learning that needs a specific index
  (e.g. reset to 0 after deleting a completed prefix). An explicit
  out-of-bounds `set_cursor` still fails.
- Do not add a new Policy intent. `repair_plan` stays.
- Candidate patches enter as `internal/plan.patch` `{ planId, patch }`.
  `plan.updated` remains a full `Plan`. Invalid patch →
  `internal/validation.failed`, not a drop.

## Consequences

- Repair stays Learning-owned.
- Graph helpers still ignore cursor.
- Diff is telemetry/UI/tests, not cognition.

## Non-Goals

- Do not let Policy call `applyPlanPatch` and write `M`.
- Do not auto-invalidate descendants in core (Learning may use
  `getPlanDescendants` and patch them).
- Do not add ATG-specific ops.
