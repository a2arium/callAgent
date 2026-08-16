# Implementation Status

Last updated: 2026-08-16.

## Stage

**Phase 0 — design harness complete** (architect punch-list applied 2026-08-16:
Phase 4 correlation + shared dispatcher; Phase 6a cursor clamp/`set_cursor`;
duplicate `dependsOn` accepted). All specs in `specs/README.md` are written.
No `plan.ts` / helper / intent / harness-fork code yet.

This branch (`planning-harness`) is design-only until Phase 1
implementation. Later phases wait on the prerequisites in each spec.

## Decisions captured

- `adr/0001-one-plan-truth.md` — **Accepted.** One Plan schema.
- `specs/plan-schema.md` — Phase 1 contract.
- `adr/0002-graph-helpers-ignore-cursor.md` — **Accepted.** No `scheduling`.
- `specs/plan-graph-helpers.md` — Phase 2 contract.
- `adr/0003-step-outputs-are-references.md` — **Accepted.** No `value` kind.
- `specs/plan-output-refs.md` — Phase 3a.
- `adr/0004-validation-is-cognition-lineage-explains-revision.md` —
  **Accepted.** Opt-in ready flag; no `MentalState.extensions`.
- `specs/plan-validation-and-lineage.md` — Phase 3b.
- `adr/0005-execute-step-names-a-step.md` — **Accepted.** One intent per turn.
  Shared dispatcher; pending token↔step correlation; Execution does not
  check `dependsOn`.
- `specs/execute-step-intent.md` — Phase 4.
- `adr/0006-turntrace-extensions-are-telemetry.md` — **Accepted.** No
  first-class `related` / `memoryReads` / `DecisionTrace`.
- `specs/turn-trace-extensions.md` — Phase 5a.
- `adr/0007-durable-memory-reads-are-not-observations.md` — **Accepted.**
- `specs/memory-read-vs-observation.md` — Phase 5b.
- `adr/0008-planpatch-is-learning-owned.md` — **Accepted.** `plan.patch`
  observation; Learning applies; clamp `cursor` unless explicit `set_cursor`.
- `specs/plan-patch.md` — Phase 6a.
- `adr/0009-harness-snapshot-fork-isolates-branches.md` — **Accepted.**
- `specs/harness-snapshot-fork.md` — Phase 6b.

## Not yet written

- Nothing in `specs/README.md`. Originating request §8
  (`MentalState.extensions`) stays rejected (no spec).
- Permanent docs (`0-aplret_contracts.md`, how-tos, migration note) update
  **with** each implementation phase, not now.

## Current runtime facts (as of `main` @ 7a6caac)

- `packages/core/src/types/plan.ts` has no `dependsOn`; step field is
  `description`; optional `intent`; `result: unknown`.
- Intents: `create_plan` | `execute_next_step` | `repair_plan`.
- Default execution stubs `create_plan` only; `execute_next_step` falls
  through.
- No graph helpers / PlanPatch / TurnTrace.extensions / harness fork.
- Operator `memory.read` events already exist.
- TestHarness has `seedMentalState` / traces / `deterministicTime`; no
  `snapshot()` / `fork()`.

## Originating request

`apps/docs/todo/improvements-planning-dependencies-etc.md` is the research
ask. It is **not** the spec. This workspace is the spec process that replaces
implementing that document as written.
