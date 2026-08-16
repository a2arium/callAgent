# Planning Model Design Principles

## Core model

Plans are **cognition**. They live in `MentalState.plans`, are written only by
Learning, and are read by Policy as compact state.

Plan *computation* (LLM/tool generation or repair) is an **effect**. It happens
in Execution, re-enters as `internal/plan.*` observations, and is validated
before Learning writes.

The loop is not a planner and not a DAG scheduler. It runs one turn, one intent,
one effect boundary. Graph readiness is derived by pure helpers that Policy and
Learning call.

## Principles

1. **One Plan truth.** There is a single Zod `Plan` / `PlanStep` schema. Docs
   infer from that schema. No second documented shape.
2. **Structural kind, executable intent.** `StepKind` is `action | subgoal |
   internal`. What to run is `intent?: ExecutableStepIntent`, not
   `kind: 'call_tool'` plus untyped `args`.
3. **Cursor stays.** Sequential agents keep `execute_next_step` and `cursor`.
   DAG agents ignore cursor for readiness and use helpers + `execute_step`.
   `cursor` is not optional; it is unused in DAG mode, not deleted.
4. **Helpers, not a scheduling mode.** `validatePlanGraph` and ready/blocked
   selectors are library functions. Do not add `scheduling: 'dependencies'` as a
   runtime switch until the intent contract can name a step — and even then the
   loop does not schedule. Helpers ignore `cursor` (ADR 0002). A cursor-only
   plan has every pending step ready according to the helper; sequential Policy
   simply does not call it.
5. **One intent per turn.** Policy arrays are stochastic samples, not parallel
   steps. Parallel work is Execution fan-out into `pending.children` /
   `pending.tools`.
6. **Step intents are executable.** A step must not store `create_plan`,
   `execute_next_step`, `repair_plan`, or `execute_step`. Those are Policy-level.
7. **References, not payloads.** Step outputs are artifact / memory / evidence
   refs. `PlanStep.result: unknown` is removed. MentalState and TurnTrace stay
   compact.
8. **Validation on a step is cognition.** Optional `validation` means
   “downstream-usable,” written by Learning. It is not Perception’s schema
   check and not a control flag.
9. **Extensibility is typed overlays on existing slots.** Plan/step `meta` is
   Zod JSON (`PlanMetaSchema`) with an optional TypeScript overlay. Agent
   graph/belief state goes in `meta` or `worldModel`, not a new
   `MentalState.extensions` bag (originating request §8 is rejected).
10. **TurnTrace stays compact.** New planner/retrieval detail is namespaced,
    versioned extensions. Do not add first-class TurnTrace fields for ATG.
    Sidecar bulk stays in artifacts, correlated by existing ids.
11. **Memory retrieval is not a new observation.** Durable reads may hydrate
    cognition in Learning. They must not be injected as duplicate
    `env.inbox.current` evidence.
12. **Zod-first, closed unions, no public `any`.** Types-rules.md applies to
    every new contract in this work.
13. **Tests are turn scripts.** Schema tests for Plan; TestHarness turn scripts
    for create / execute / repair / resume; pure unit tests for graph helpers.

## Non-negotiables

- Do not add `AtomicTaskGraph`, beliefs, expected free energy, or negative
  transfer to core.
- Do not let Policy mutate plans or read durable memory as if it were `M`.
- Do not let Execution or Transition write `M.plans`.
- Do not store large step results inline in plans or traces.
- Do not introduce a second cognitive store.
- Do not make Hatchet, operator, or ATG types part of the Plan API.
- Do not keep the current docs shape and the current `plan.ts` shape in
  parallel.

## Mapping summary (role ownership)

| Concern | Owner |
|---|---|
| Plan schema / Zod | `packages/core` (`types/plan.ts`) |
| Graph validate / ready / blocked | pure helpers in core, called by agents |
| Authoritative plan write | Learning via `MemoryWriter.plans` |
| Choose create / next / step / repair | Policy (sync, `M` only) |
| LLM/tool plan generation and step effects | Execution |
| `internal/plan.*` observations | Transition |
| Schema validation of those observations | Perception |
| Compact planner telemetry | TurnTrace extensions |
| ATG / beliefs / scoring | agent `meta` / `worldModel` |
