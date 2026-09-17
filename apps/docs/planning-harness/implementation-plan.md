# Implementation Plan

Staged plan to give APLRET one Plan truth and the helpers DAG agents need,
without turning the loop into a scheduler. Each phase is independently
reviewable. Production runtime for a phase follows that phase’s spec. This
pack is stamped (architect punch-list applied 2026-08-16).

## Phase 0 — Design harness (this folder)

Goal: capture decisions and the procedure before code.

1. [x] Create this workspace (README, principles, ADR 0001, testing principles).
2. [x] Write `specs/plan-schema.md`.
3. [x] Write `specs/plan-graph-helpers.md` (ADR 0002 Accepted).
4. [x] Write remaining specs (output refs, validation/lineage, `execute_step`,
      TurnTrace, memory-read, PlanPatch, snapshot fork).
5. [x] Scenario 0 in `harness/poc-scenarios.md` matches the plan-schema spec.
6. [x] Scenarios 1–2 match `specs/plan-graph-helpers.md`.
7. [x] Scenarios 4–8 match Phase 3–6 specs.
8. [x] Migration note shape agreed: `apps/docs/migration/plan-schema-one-truth.md`
      in the same PR as `plan.ts` (see plan-schema spec).

Acceptance for Phase 1 start: `specs/plan-schema.md` is enough to implement
without inventing field names.

Acceptance for Phase 2 start: Phase 1 code has landed; `specs/plan-graph-helpers.md`
is enough to implement without a `scheduling` field.

Deletes: nothing.

## Phase 1 — One Plan schema

Goal: `plan.ts` is the only Plan truth; docs match it.

Prerequisites: ADR 0001 accepted; `specs/plan-schema.md` written.

Follow `specs/plan-schema.md` as the implementation contract. Summary:

1. Split `IntentSchema` members; add `ExecutableStepIntentSchema`.
2. Rewrite `PlanSchema` / `PlanStepSchema` (title, dependsOn, meta, stale,
   ISO timestamps, `.strict()`, graph superRefine).
3. Type `plan.proposed` / `plan.updated` / `plan.step.updated` on
   `ObservationSchema`. Default Perception replaces invalid plan payloads
   with `internal/validation.failed` (do not drop). Default Learning
   re-parses before write.
4. Export schemas from `@a2arium/callagent-core`.
5. Rewrite `planning.model.test.ts`, add `plan.types.test-d.ts`, plus a
   loop-stub / `validation.failed` test.
6. Rewrite contracts, goals/plans spec, planning how-to; add
   `apps/docs/migration/plan-schema-one-truth.md`.

Acceptance: listed in `specs/plan-schema.md`.

## Phase 2 — Dependency graph helpers

Goal: `dependsOn` has deterministic semantics without a loop scheduler.

Prerequisites: Phase 1 code; ADR 0002 accepted; `specs/plan-graph-helpers.md`.

Follow `specs/plan-graph-helpers.md` as the implementation contract. Summary:

1. Share Phase 1’s `collectPlanGraphIssues` with public `validatePlanGraph`
   (`unknown` in, result type, never throws).
2. `selectReadyPlanSteps` / `selectBlockedPlanSteps` — pending steps only;
   a dep is satisfied iff `completed`; ignore `cursor` and `plan.status`.
3. `getPlanDependants` / `getPlanAncestors` / `getPlanDescendants` —
   missing id is `PLAN_STEP_NOT_FOUND`, not `[]`.
4. Unit tests in `packages/core/tests/planGraph.test.ts` plus tsd cases.
   Do **not** add `requireValidatedDependencies` (Phase 3).
5. Rewrite the permanent docs listed in the spec (especially spec 8’s
   “rely solely on cursor” sentence).

Acceptance: listed in `specs/plan-graph-helpers.md`. Helpers are exported
from core; default Policy still uses `execute_next_step` + `cursor`.

## Phase 3 — Provenance on steps

Goal: add compact output refs and record why a plan changed.

Prerequisites: Phase 1 (`result` already removed); `specs/plan-output-refs.md`
and `specs/plan-validation-and-lineage.md`.

Follow those specs. Summary:

1. Optional `outputs?: PlanOutputRef[]` (`artifact | memory | evidence` only;
   no `value` kind).
2. Optional `validation?: ValidationState` (Learning-owned, not schema-check).
3. Optional `lineage?: PlanRevisionLineage`; `revision` stays monotonic
   across turns by Learning; Zod only checks `parentRevision < revision`.
4. Extend Phase 2 helpers with optional
   `{ requireValidatedDependencies?: boolean }` (default identical to Phase 2).
   Do not add `selectRunnablePlanSteps`.
5. Snapshot/resume tests: refs, validation, and lineage survive JSON.

Acceptance: listed in the two Phase 3 specs. No `z.unknown()` step result;
artifact rule holds; `MentalState.extensions` is not added.

## Phase 4 — `execute_step`

Goal: DAG Policy can name a ready step.

Prerequisites: Phases 1–2; `specs/execute-step-intent.md`.

Follow that spec. Summary:

1. Add `execute_step { planId, stepId }` to `PlanningIntentSchema` only.
2. Shared `dispatchStoredPlanStep` for `execute_step` and
   `execute_next_step` (replaces the next-step no-op stub).
3. Stamp `planId` / `stepId` / `advanceCursor` on pending await records;
   continue path uses `planStepUpdated`. Default Learning correlates.
4. Execution does **not** check `dependsOn`. Default Policy stays sequential.

Acceptance: listed in `specs/execute-step-intent.md`.

## Phase 5 — Observability and memory rule

Goal: custom planner telemetry without bloating TurnTrace; document memory
vs observation.

Prerequisites: `specs/turn-trace-extensions.md`,
`specs/memory-read-vs-observation.md`.

Follow those specs. Summary:

1. Optional namespaced, versioned `TurnTrace.extensions` (JSON `data`, no
   first-class `related` / `memoryReads` / `DecisionTrace`).
2. Opt-in `recordTurnTraceExtension`; invalid items do not fail the turn.
3. Contracts + memory how-to: durable reads are not inbox observations.
4. Point at existing operator `memory.read` events; do not auto-emit a
   TurnTrace extension for every read.

Acceptance: listed in the two Phase 5 specs.

## Phase 6 — Repair and counterfactual tests (P1)

Goal: structured repair and isolated harness forks.

Prerequisites: Phases 1–2 for patches; harness fork is independent.
`specs/plan-patch.md`, `specs/harness-snapshot-fork.md`.

Follow those specs. Summary:

1. `PlanPatch` + `internal/plan.patch`; Learning applies; `diffPlanGraph`
   is pure. After ops, clamp `cursor` unless `set_cursor` was explicit.
2. TestHarness opaque `snapshot()` / `fork()` with deep isolation.
3. Optional `randomSeed` for Policy-array sampling only; do not seed
   process-wide `Math.random`.

Acceptance: listed in the two Phase 6 specs.
