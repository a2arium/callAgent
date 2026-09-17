# Implementation Status

Last updated: 2026-08-16.

## Stage

**Phases 1–6 implemented** on branch `planning-harness`. Specs in
`specs/README.md` remain the contracts. Architect punch-list was applied
before coding (Phase 4 correlation + shared dispatcher; Phase 6a cursor
clamp/`set_cursor`; duplicate `dependsOn` accepted).

## Decisions captured

- `adr/0001-one-plan-truth.md` — **Accepted.** One Plan schema.
- `adr/0002-graph-helpers-ignore-cursor.md` — **Accepted.** No `scheduling`.
- `adr/0003-step-outputs-are-references.md` — **Accepted.** No `value` kind.
- `adr/0004-validation-is-cognition-lineage-explains-revision.md` —
  **Accepted.** Opt-in ready flag; no `MentalState.extensions`.
- `adr/0005-execute-step-names-a-step.md` — **Accepted.** One intent per turn.
- `adr/0006-turntrace-extensions-are-telemetry.md` — **Accepted.**
- `adr/0007-durable-memory-reads-are-not-observations.md` — **Accepted.**
- `adr/0008-planpatch-is-learning-owned.md` — **Accepted.**
- `adr/0009-harness-snapshot-fork-isolates-branches.md` — **Accepted.**

## Runtime (this branch)

- `PlanSchema`: `title`, `dependsOn` (uniquify duplicates), structural
  `kind`, optional executable `intent`, JSON `meta`, ISO timestamps.
- Intents: `create_plan` | `execute_next_step` | `execute_step` |
  `repair_plan` plus executable kinds. `execute_step` is planning-only.
- Shared `dispatchStoredPlanStep` / `resolveStoredPlanStep` for named and
  cursor steps. Default Learning correlates pending stamps.
- Graph helpers ignore cursor. Output refs / validation / lineage optional.
- `applyPlanPatch` / `plan.patch` observation. TurnTrace `extensions`.
- TestHarness `snapshot()` / `fork()`. EngineLocator is not isolation-safe.

## Rejected (not added)

- `MentalState.extensions`
- `Plan.scheduling`
- `kind: 'value'` outputs
- Parallel Policy intents
- First-class `TurnTrace.related` / `memoryReads` / `DecisionTrace`
