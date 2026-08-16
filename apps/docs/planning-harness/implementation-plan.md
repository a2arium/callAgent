# Implementation Plan

Staged plan to give APLRET one Plan truth and the helpers DAG agents need,
without turning the loop into a scheduler. Each phase is independently
reviewable. Production runtime code should not change until the ADRs and specs
for that phase are written and reviewed.

## Phase 0 — Design harness (this folder)

Goal: capture decisions and the procedure before code.

1. Create this workspace (README, principles, ADR 0001, testing principles).
2. Write specs for the schema, graph helpers, intents, output refs, and
   TurnTrace extensions.
3. Write harness scenarios with pass/fail gates.
4. Agree the migration note shape (docs + `plan.ts` in one change set).

Acceptance: reviewers can implement Phase 1 from specs without inventing
field names.

Deletes: nothing.

## Phase 1 — One Plan schema

Goal: `plan.ts` is the only Plan truth; docs match it.

Prerequisites: ADR 0001 accepted; `specs/plan-schema.md` written.

1. Update `PlanSchema` / `PlanStepSchema` per ADR 0001.
2. Restrict step `intent` to `ExecutableStepIntent`.
3. Rewrite contracts, `8-spec_goals_and_plans`, and the planning how-to from
   the schema.
4. Add schema tests (valid, cursor bounds, unique step ids, rejected
   planning-intents on steps).
5. Migration note: not backward compatible; no dual shape.

Acceptance: `PlanSchema.parse` and the three docs describe the same type;
`yarn test` for planning schema tests is green.

## Phase 2 — Dependency graph helpers

Goal: `dependsOn` has deterministic semantics without a loop scheduler.

Prerequisites: Phase 1; `specs/plan-graph-helpers.md`.

1. `validatePlanGraph(plan)` — missing, self, cycle; structured error codes.
2. `selectReadyPlanSteps` / `selectBlockedPlanSteps` / ancestor/descendant
   helpers.
3. Optional `requireValidatedDependencies` once Phase 3 validation exists.
4. Pure unit tests as listed in `harness/poc-scenarios.md`.

Acceptance: helpers are exported from core; default Policy still uses
`execute_next_step` + `cursor`.

## Phase 3 — Provenance on steps

Goal: replace inline `result` and record why a plan changed.

Prerequisites: Phase 1; specs for outputs, validation, lineage.

1. Replace `result` with compact `outputs?: PlanOutputRef[]`.
2. Optional `validation?: ValidationState` (Learning-owned).
3. Optional `lineage?: PlanRevisionLineage`; `revision` stays monotonic.
4. Snapshot/resume tests: refs and lineage survive serialization.

Acceptance: no `z.unknown()` step result in the schema; artifact rule holds.

## Phase 4 — `execute_step`

Goal: DAG Policy can name a ready step.

Prerequisites: Phases 1–2; `specs/execute-step-intent.md`.

1. Add `execute_step { planId, stepId }` to `IntentSchema`.
2. Document: one intent per turn; fan-out stays in Execution.
3. Default execution still does not become a scheduler; agents interpret the
   step’s stored `intent`.
4. Turn-script tests: two independent ready steps, Policy picks one, the
   other stays ready.

Acceptance: sequential `execute_next_step` still works; DAG path does not
use cursor for readiness.

## Phase 5 — Observability and memory rule

Goal: custom planner telemetry without bloating TurnTrace; document memory
vs observation.

1. Namespaced, versioned `TurnTrace.extensions`.
2. Contracts + memory how-to: durable reads are not inbox observations.
3. Point at existing operator `memory.read` events; optional compact
   extension summarizing them (no payloads).

Acceptance: core TurnTrace first-class fields are unchanged except
`extensions`; memory-read rule is normative text.

## Phase 6 — Repair and counterfactual tests (P1)

Goal: structured repair and isolated harness forks.

Prerequisites: Phases 1–4.

1. `PlanPatch` + `diffPlanGraph`; Learning applies patches.
2. TestHarness `snapshot()` / `fork()` with deep isolation.
3. Generalize test clock; RNG only if a test samples
   `policyParams.stochastic`.

Acceptance: two forks from one snapshot cannot mutate each other; patch
apply is Learning-owned.
