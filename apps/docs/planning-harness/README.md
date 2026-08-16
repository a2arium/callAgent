# Planning Model Harness

This is a temporary design and validation workspace for the APLRET planning
model: one Plan schema, dependency-aware helpers, provenance, and the intents
needed to execute graph plans without turning the loop into a scheduler.

It mirrors the structure of `apps/docs/orchestrator-harness/` and the (now
promoted) streaming harness. Production `packages/core` code should not change
until the principles, ADRs, and specs here are reviewed.

Delete this folder only after:

- Accepted ADRs are moved or referenced from permanent architecture docs.
- Accepted specs are promoted into `0-aplret_contracts.md`,
  `8-spec_goals_and_plans_in_aplret.md`, `9-how_to_implement_planning_without_breaking_policy_purity.md`,
  and a migration guide.
- Harness scenarios are converted into permanent automated tests.
- The originating request doc is archived or replaced by the promoted specs.

## Core thesis

callAgent already has a planning *slot* (`M.plans`, `create_plan` /
`execute_next_step` / `repair_plan`, `internal/plan.*` observations,
`MemoryWriter.plans`). It does not yet have one Plan *truth*.

Contracts and how-tos describe a DAG-capable step (`dependsOn`, action-kinds,
`args`). Runtime `packages/core/src/types/plan.ts` describes a sequential step
(`description`, structural `kind`, optional `intent`, inline `result`, no
`dependsOn`). Neither side is the public contract we want.

This workspace designs the merged model:

- one Zod-backed `Plan` / `PlanStep`;
- structural step kind + optional validated `intent`;
- optional `dependsOn` with pure graph helpers;
- Policy still emits **one intent per turn**;
- DAG agents select a ready step via helpers and `execute_step`;
- large results stay in artifacts; TurnTrace stays compact.

Atomic Task Graph, beliefs, and repair policy stay in agent `meta` /
`worldModel`. They are not framework types.

## Scope

This workspace covers:

- Reconciling Plan/PlanStep/PlanStatus across code and docs.
- Dependency graph validation and ready/blocked selectors as library helpers.
- Step output refs, optional validation state, and revision lineage.
- `execute_step(planId, stepId)` and the sequential-vs-DAG Policy contract.
- TurnTrace extension points for planner telemetry (not new first-class fields).
- The normative rule that durable memory reads are not new observations.
- Later: `PlanPatch`, plan diffs, and test-harness snapshot fork.

This workspace does **not** add ATG, active inference, a second cognitive store,
a loop-level DAG scheduler, or parallel Policy intents.

## Normative inputs

The design here must comply with:

- `apps/docs/0-aplret_contracts.md` (APLRET contracts).
- `apps/docs/8-spec_goals_and_plans_in_aplret.md` (goals/plans spec — currently
  drifted from `plan.ts`).
- `apps/docs/9-how_to_implement_planning_without_breaking_policy_purity.md`.
- `apps/docs/7-how_to_use_artifacts_correctly_aplret.md`.
- `apps/docs/11-how_to_test_aplret_agents.md`.
- `apps/docs/12-how_to_debug_with_turn_trace.md`.
- `apps/docs/18-how_to_use_memory_in_aplret.md`.
- `apps/docs/todo/types-rules.md` (Zod-first, no public `any`, closed unions).

Non-normative origin (problem statement, not the API to implement):

- `apps/docs/todo/improvements-planning-dependencies-etc.md`

In particular:

- Learning is the only writer of `MentalState` (including plans).
- Policy is synchronous and reads only `MentalState`.
- Plan generation/repair that uses an LLM or tool is an Execution effect.
- Zod schemas are the source of truth; TypeScript generics are overlays.
- This framework does not keep dual Plan shapes for compatibility.

## Contents

- `principles.md` — design principles and non-negotiables.
- `testing-principles.md` — schema, turn-script, and helper-test strategy.
- `implementation-plan.md` — staged implementation plan.
- `implementation-status.md` — where we are right now.
- `migration-checklist.md` — promotion/deletion checklist.
- `adr/` — decision records to review before implementation.
- `specs/` — schema, helper, intent, and observability specs (to be written).
- `harness/` — POC scenarios and expected outcomes.

Start with `adr/0001-one-plan-truth.md` when reviewing this workspace; it carries
the central schema decision everything else depends on.
