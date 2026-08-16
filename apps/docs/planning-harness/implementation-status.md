# Implementation Status

Last updated: 2026-08-16.

## Stage

**Phase 0 — design harness created. Specs not yet written.**

Local `main` includes the `hatchet` fast-forward. This branch
(`planning-harness`) exists only to design the planning-model work. No
`packages/core` Plan schema changes have been made on this branch.

## Decisions captured

- `adr/0001-one-plan-truth.md` — Proposed. Migrate `plan.ts` toward documented
  product language; keep structural `kind` + `intent`; add `dependsOn`,
  `title`, `stale`, ISO timestamps; drop action-kinds/`args`/inline `result`.

## Not yet written

- Specs listed in `specs/README.md`.
- Further ADRs (`execute_step`, output refs, TurnTrace extensions, PlanPatch,
  harness fork).
- Detailed harness scenarios beyond the skeleton in `harness/poc-scenarios.md`.

## Current runtime facts (as of `main` @ 7a6caac)

- `packages/core/src/types/plan.ts` has no `dependsOn`; step field is
  `description`; optional `intent`; `result: unknown`.
- Intents: `create_plan` | `execute_next_step` | `repair_plan`.
- Default execution stubs `create_plan` only.
- Operator `memory.read` events already exist; TurnTrace has no `extensions`.
- TestHarness has `seedMentalState` / traces / `deterministicTime`; no
  `snapshot()` / `fork()`.

## Originating request

`apps/docs/todo/improvements-planning-dependencies-etc.md` is the research
ask. It is **not** the spec. This workspace is the spec process that replaces
implementing that document as written.
