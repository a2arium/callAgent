# Migration Checklist

Use this when moving from this harness to production code and permanent docs.
Mirrors the orchestrator-harness / streaming-harness checklist style.

## Phase 0 — Design

- [x] Create temporary workspace.
- [x] Draft principles and ADR 0001.
- [ ] Write specs listed in `specs/README.md`.
- [ ] Fill harness scenarios with pass/fail gates.
- [ ] Review ADRs/specs before any `plan.ts` change.

## Phase 1 — Schema truth

- [ ] `PlanSchema` / `PlanStepSchema` match ADR 0001.
- [ ] `ExecutableStepIntent` rejects planning intents on steps.
- [ ] `0-aplret_contracts.md` Plan types match the schema.
- [ ] `8-spec_goals_and_plans_in_aplret.md` rewritten from the schema.
- [ ] `9-how_to_implement_planning_without_breaking_policy_purity.md` rewritten.
- [ ] Migration guide under `apps/docs/migration/`.
- [ ] Schema tests green; no dual Plan shape left in docs.

## Phase 2 — Graph helpers

- [ ] `validatePlanGraph` structured errors (missing, self, cycle).
- [ ] Ready / blocked / ancestor / descendant helpers exported.
- [ ] Helper unit tests parse fixtures through `PlanSchema`.
- [ ] Default Policy still sequential (`execute_next_step` + `cursor`).

## Phase 3 — Provenance

- [ ] `PlanStep.result` removed; `outputs` refs in schema.
- [ ] Optional validation state and revision lineage.
- [ ] Artifact how-to referenced from planning docs.
- [ ] Snapshot/resume tests for refs and lineage.

## Phase 4 — execute_step

- [ ] `execute_step` on `IntentSchema`.
- [ ] How-to documents one-intent-per-turn and Execution fan-out.
- [ ] Turn script: two ready steps, one executed, the other still ready.

## Phase 5 — Observability

- [ ] `TurnTrace.extensions` schema (namespace + version + JSON data).
- [ ] Memory-read ≠ observation written into contracts and memory how-to.
- [ ] No first-class ATG/planner fields added to TurnTrace.

## Phase 6 — Repair and fork

- [ ] `PlanPatch` apply path is Learning-owned.
- [ ] Harness `snapshot()` / `fork()` deep-clone isolation tests.

## Promotion / deletion

- [ ] Accepted ADRs referenced from permanent docs.
- [ ] Originating request archived under `apps/docs/todo/done/` or replaced.
- [ ] This folder deleted after promotion.
