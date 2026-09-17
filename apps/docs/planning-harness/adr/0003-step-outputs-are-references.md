# ADR 0003: Step Outputs Are References

## Status

Accepted

Implementation contract: `specs/plan-output-refs.md`.

## Context

The originating request wanted `PlanStep.outputs?: PlanOutputRef[]` with
kinds `artifact | memory | evidence | value`, so lineage can point at
results without stuffing blobs into `MentalState`.

Phase 1 already removed `PlanStep.result: unknown`. If we put a `value`
kind back, agents will serialize payloads into `ref` and recreate the
blob problem.

APLRET already has artifact handles and durable memory ids. Plans should
point at those, not duplicate them.

## Decision

- Add optional `outputs?: PlanOutputRef[]` on `PlanStep`.
- Closed `kind`: `artifact | memory | evidence`. **No `value` kind.**
- `ref` is a non-empty string handle. No `payload` field.
- Optional `name` is a local binding, unique within that step when set.
- Unified `outputs` array; do not add parallel `resultRefs` /
  `evidenceRefs` / `artifactRefs`.
- Learning writes outputs. Execution/Transition do not patch `M.plans`.
- Core does not auto-copy tool results into `outputs`.

## Consequences

- `7-how_to_use_artifacts_correctly_aplret.md` becomes the planning
  companion for step results.
- Snapshot/resume tests must round-trip refs, not payloads.
- Phase 3 validation `refs` may point at output `name`s or `ref`s; they
  are not a second payload slot.

## Non-Goals

- Do not restore `PlanStep.result`.
- Do not add ATG output schemas to core.
- Do not hydrate artifacts in Policy.
