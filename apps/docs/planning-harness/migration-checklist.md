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

- [ ] `PlanSchema` / `PlanStepSchema` match ADR 0001 and the spec.
- [ ] `ExecutableStepIntent` rejects planning intents on steps.
- [ ] Graph superRefine: duplicate id, missing dep, self, cycle, cursor.
- [ ] Duplicate ids in one `dependsOn` list accepted (one edge), not rejected.
- [ ] `PlanStep.result` / `description` / `args` gone; `.strict()`.
- [ ] `ObservationSchema` types the three plan kinds (nested `kind` union).
- [ ] Default Perception replaces invalid plan.* with `validation.failed`
      (does not drop).
- [ ] Default Learning re-parses before `set`/`add` and after step patch.
- [ ] `MemoryWriter.plans` stays trust-Learning (no writer parse).
- [ ] `plan.types.test-d.ts` added; `yarn test:types` green.
- [ ] Schemas exported from `@a2arium/callagent-core`.
- [ ] `0-aplret_contracts.md` Plan types match the schema.
- [ ] `8-spec_goals_and_plans_in_aplret.md` rewritten from the schema.
- [ ] `9-how_to_implement_planning_without_breaking_policy_purity.md` rewritten.
- [ ] `apps/docs/migration/plan-schema-one-truth.md` written in the same PR.
- [ ] `planning.model.test.ts` fixtures updated; accept/reject cases from spec.
- [ ] Loop stub `create_plan` still parses; legacy `description` payload
      becomes `validation.failed`, not a drop.
- [ ] `packages/core` test suite green; leftover Plan fixtures updated, not loosened.

## Phase 2 — Graph helpers

See `specs/plan-graph-helpers.md` for the full contract.

- [ ] `validatePlanGraph(unknown)` result type; never throws.
- [ ] Codes match Phase 1: missing, self, cycle, duplicate step id, cursor;
      other Zod failures → `PLAN_SCHEMA_INVALID`.
- [ ] Ready / blocked ignore `cursor` and `plan.status`; dep satisfied iff
      `completed`.
- [ ] Ancestor / descendant / dependant lookups; missing id →
      `PLAN_STEP_NOT_FOUND` (not `[]`).
- [ ] No `scheduling` field; no `requireValidatedDependencies`.
- [ ] `packages/core/tests/planGraph.test.ts`; fixtures through `PlanSchema`.
- [ ] tsd cases in `plan.types.test-d.ts`.
- [ ] Named exports from `@a2arium/callagent-core`.
- [ ] Default Policy still sequential (`execute_next_step` + `cursor`).
- [ ] `0-aplret_contracts.md` planning model: cursor **or** helpers; one intent.
- [ ] `8-spec_goals_and_plans_in_aplret.md` no longer says Policy relies
      *solely* on `cursor`.
- [ ] `9-how_to_implement_planning_without_breaking_policy_purity.md` shows
      both sequential and DAG patterns.
- [ ] `3-how_to_keep_policy_pure.md` Case 5: helpers are M-only.
- [ ] `11-how_to_test_aplret_agents.md` helper unit-test note.
- [ ] `packages/core` `yarn test` + `yarn test:types` green; Phase 1 schema
      tests not loosened.

## Phase 3 — Provenance

See `specs/plan-output-refs.md` and `specs/plan-validation-and-lineage.md`.

- [ ] `PlanOutputRef` kinds `artifact | memory | evidence` only (no `value`).
- [ ] Duplicate output `name` on one step rejected.
- [ ] `result` / `payload` on steps still rejected.
- [ ] Optional `validation` + `lineage`; `PLAN_LINEAGE_PARENT` when
      `parentRevision >= revision`.
- [ ] Ready helpers default unchanged; opt-in `requireValidatedDependencies`.
- [ ] No `selectRunnablePlanSteps`; no `MentalState.extensions`.
- [ ] JSON round-trip tests for outputs / validation / lineage.
- [ ] Docs: contracts, spec 8, how-to 9, artifact how-to, migration note.
- [ ] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 4 — execute_step

See `specs/execute-step-intent.md`.

- [ ] `execute_step` on `PlanningIntentSchema` only, not on `PlanStep.intent`.
- [ ] Shared dispatcher for `execute_step` and `execute_next_step`.
- [ ] Pending stamp `planId`/`stepId`/`advanceCursor`; default Learning
      correlates terminal observations (cleanup after Learning).
- [ ] Execution does not check `dependsOn` (blocked-but-named still runs).
- [ ] `execute_step` does not advance `cursor`; `execute_next_step` does
      after completion when `advanceCursor` is true.
- [ ] Kind-parity test vs memory-engine scaffold.
- [ ] Exhaustive `Intent` / HITL kind lists updated.
- [ ] Default Policy still sequential.
- [ ] Exhaustive `Intent` / HITL kind lists updated.
- [ ] Turn script: two ready steps, one executed, the other still ready.
- [ ] Docs: contracts, spec 8, how-to 9, policy purity Case 5, tests how-to.
- [ ] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 5 — Observability

See `specs/turn-trace-extensions.md` and
`specs/memory-read-vs-observation.md`.

- [ ] `TurnTrace.extensions` (namespace + version + JSON data).
- [ ] No first-class `related` / `memoryReads` / `DecisionTrace` / ATG fields.
- [ ] `recordTurnTraceExtension` opt-in; invalid items do not fail the turn.
- [ ] Durable read ≠ inbox observation (contracts + memory how-to).
- [ ] Operator `memory.read` remains default telemetry (no payloads).
- [ ] Turn-script: Learning read does not grow inbox with retrieved data.
- [ ] `packages/core` `yarn test` + `yarn test:types` green.

## Phase 6 — Repair and fork

See `specs/plan-patch.md` and `specs/harness-snapshot-fork.md`.

- [ ] `PlanPatch` + `internal/plan.patch`; Learning apply only.
- [ ] Invalid patch → `validation.failed`, not drop.
- [ ] `diffPlanGraph` pure; `baseRevision` mismatch fails apply.
- [ ] `remove_step` that would OOB `cursor` clamps; `set_cursor` optional.
- [ ] Opaque `snapshot()` / `fork()`; A cannot mutate B.
- [ ] Production `Snapshot` type unchanged.
- [ ] Optional `randomSeed` off by default; not process-wide `Math.random`.
- [ ] Docs: contracts, planning how-to, test how-to.
- [ ] `packages/core` `yarn test` + `yarn test:types` green.

## Promotion / deletion

- [ ] Accepted ADRs referenced from permanent docs.
- [ ] Originating request archived under `apps/docs/todo/done/` or replaced.
- [ ] This folder deleted after promotion.
