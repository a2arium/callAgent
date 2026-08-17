# Migration Checklist

Use this when moving from this harness to production code and permanent docs.
Mirrors the orchestrator-harness / streaming-harness checklist style.

## Phase 0 — Design

- [x] Create temporary workspace.
- [x] Draft principles and ADR 0001.
- [x] Draft ADR 0002 (helpers ignore cursor; no `scheduling` field).
- [x] Write `specs/plan-schema.md`.
- [x] Write `specs/plan-graph-helpers.md`.
- [x] Write remaining specs listed in `specs/README.md`.
- [x] Scenario 0 filled against the plan-schema spec.
- [x] Scenarios 1–2 filled against the plan-graph-helpers spec.
- [x] Scenarios 4–8 filled against Phase 3–6 specs.
- [x] Review ADR 0001 + `specs/plan-schema.md` before any `plan.ts` change.
      ADR 0001 Accepted; spec punch-list closed.
- [x] Review ADR 0002 + `specs/plan-graph-helpers.md` before helper code.
      ADR 0002 Accepted.
- [x] ADRs 0003–0009 Accepted with matching specs (outputs, validation/
      lineage, `execute_step`, TurnTrace extensions, memory-read rule,
      PlanPatch, harness fork).

## Phase 1 — Schema truth

See `specs/plan-schema.md` for the full contract.

- [x] `PlanSchema` / `PlanStepSchema` match ADR 0001 and the spec.
- [x] `ExecutableStepIntent` rejects planning intents on steps.
- [x] Graph superRefine: duplicate id, missing dep, self, cycle, cursor.
- [x] Duplicate ids in one `dependsOn` list accepted (one edge), not rejected.
- [x] `PlanStep.result` / `description` / `args` gone; `.strict()`.
- [x] `ObservationSchema` types the three plan kinds (nested `kind` union).
- [x] Default Perception replaces invalid plan.* with `validation.failed`
      (does not drop).
- [x] Default Learning re-parses before `set`/`add` and after step patch.
- [x] `MemoryWriter.plans` stays trust-Learning (no writer parse).
- [x] `plan.types.test-d.ts` added; `yarn test:types` green.
- [x] Schemas exported from `@a2arium/callagent-core`.
- [x] `0-aplret_contracts.md` Plan types match the schema.
- [x] `8-spec_goals_and_plans_in_aplret.md` rewritten from the schema.
- [x] `9-how_to_implement_planning_without_breaking_policy_purity.md` rewritten.
- [x] `apps/docs/migration/plan-schema-one-truth.md` written in the same PR.
- [x] `planning.model.test.ts` fixtures updated; accept/reject cases from spec.
- [x] Loop stub `create_plan` still parses; legacy `description` payload
      becomes `validation.failed`, not a drop.
- [x] `packages/core` test suite green; leftover Plan fixtures updated, not loosened.

## Phase 2 — Graph helpers

See `specs/plan-graph-helpers.md` for the full contract.

- [x] `validatePlanGraph(unknown)` result type; never throws.
- [x] Codes match Phase 1: missing, self, cycle, duplicate step id, cursor;
      other Zod failures → `PLAN_SCHEMA_INVALID`.
- [x] Ready / blocked ignore `cursor` and `plan.status`; dep satisfied iff
      `completed`.
- [x] Ancestor / descendant / dependant lookups; missing id →
      `PLAN_STEP_NOT_FOUND` (not `[]`).
- [x] No `scheduling` field; no `requireValidatedDependencies`.
- [x] `packages/core/tests/planGraph.test.ts`; fixtures through `PlanSchema`.
- [x] tsd cases in `plan.types.test-d.ts`.
- [x] Named exports from `@a2arium/callagent-core`.
- [x] Default Policy still sequential (`execute_next_step` + `cursor`).
- [x] `0-aplret_contracts.md` planning model: cursor **or** helpers; one intent.
- [x] `8-spec_goals_and_plans_in_aplret.md` no longer says Policy relies
      *solely* on `cursor`.
- [x] `9-how_to_implement_planning_without_breaking_policy_purity.md` shows
      both sequential and DAG patterns.
- [x] `3-how_to_keep_policy_pure.md` Case 5: helpers are M-only.
- [x] `11-how_to_test_aplret_agents.md` helper unit-test note.
- [x] `packages/core` `yarn test` + `yarn test:types` green; Phase 1 schema
      tests not loosened.

## Phase 3 — Provenance

See `specs/plan-output-refs.md` and `specs/plan-validation-and-lineage.md`.

- [x] `PlanOutputRef` kinds `artifact | memory | evidence` only (no `value`).
- [x] Duplicate output `name` on one step rejected.
- [x] `result` / `payload` on steps still rejected.
- [x] Optional `validation` + `lineage`; `PLAN_LINEAGE_PARENT` when
      `parentRevision >= revision`.
- [x] Ready helpers default unchanged; opt-in `requireValidatedDependencies`.
- [x] No `selectRunnablePlanSteps`; no `MentalState.extensions`.
- [x] JSON round-trip tests for outputs / validation / lineage.
- [x] Docs: contracts, spec 8, how-to 9, artifact how-to, migration note.
- [x] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 4 — execute_step

See `specs/execute-step-intent.md`.

- [x] `execute_step` on `PlanningIntentSchema` only, not on `PlanStep.intent`.
- [x] Shared dispatcher for `execute_step` and `execute_next_step`.
- [x] Pending stamp `planId`/`stepId`/`advanceCursor`; default Learning
      correlates terminal observations (cleanup after Learning).
- [x] Execution does not check `dependsOn` (blocked-but-named still runs).
- [x] `execute_step` does not advance `cursor`; `execute_next_step` does
      after completion when `advanceCursor` is true.
- [x] Kind-parity test vs memory-engine scaffold.
- [x] Exhaustive `Intent` / HITL kind lists updated.
- [x] Default Policy still sequential.
- [x] Exhaustive `Intent` / HITL kind lists updated.
- [x] Turn script: two ready steps, one executed, the other still ready.
- [x] Docs: contracts, spec 8, how-to 9, policy purity Case 5, tests how-to.
- [x] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 5 — Observability

See `specs/turn-trace-extensions.md` and
`specs/memory-read-vs-observation.md`.

- [x] `TurnTrace.extensions` (namespace + version + JSON data).
- [x] No first-class `related` / `memoryReads` / `DecisionTrace` / ATG fields.
- [x] `recordTurnTraceExtension` opt-in; invalid items do not fail the turn.
- [x] Durable read ≠ inbox observation (contracts + memory how-to).
- [x] Operator `memory.read` remains default telemetry (no payloads).
- [x] Turn-script: Learning read does not grow inbox with retrieved data.
- [x] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 6 — Repair and fork

See `specs/plan-patch.md` and `specs/harness-snapshot-fork.md`.

- [x] `PlanPatch` + `internal/plan.patch`; Learning apply only.
- [x] Invalid patch → `validation.failed`, not drop.
- [x] `diffPlanGraph` pure; `baseRevision` mismatch fails apply.
- [x] `remove_step` that would OOB `cursor` clamps; `set_cursor` optional.
- [x] Opaque `snapshot()` / `fork()`; A cannot mutate B.
- [x] Production `Snapshot` type unchanged.
- [x] Optional `randomSeed` off by default; not process-wide `Math.random`.
- [x] Docs: contracts, planning how-to, test how-to.
- [x] `packages/core` `yarn test` + `yarn test:types` green.

## Promotion / deletion

- [x] Accepted ADRs referenced from permanent docs.
- [x] Originating request archived under `apps/docs/todo/done/` or replaced.
- [ ] This folder deleted after promotion.
