# ADR 0001: Kernel Seam And Two Drivers

## Status

Proposed

## Context

callAgent currently mixes two concerns in the same runtime area:

- the APLRET cognition kernel: `oneTurn`, `runLoop`, modules, `MentalState`,
  snapshots, and canonical stream events;
- runtime infrastructure control: when to start, resume, retry, serialize,
  wait, publish, and recover work.

The orchestrator transition must keep the cognition kernel close to what exists
today, while allowing Hatchet to provide durable control where it is a better
fit.

## Decision

Introduce a small kernel seam:

- `TurnExecutor`: runs one **segment** — one `runLoop` execution advanced to the
  next durable boundary (await / sleep / terminal) — from a persisted snapshot and
  wake, then persists and returns `SegmentResult.boundary`. Internal `continue`
  turns stay in-process (ADR 0002).
- `RuntimeDriver`: decides when/how the next segment is scheduled and what wakes it.

There are two drivers:

- `InProcessRuntimeDriver`: default, zero-infra, reproduces current behavior.
- `HatchetRuntimeDriver`: opt-in, uses Hatchet durable execution primitives.

The APLRET kernel is shared by both drivers. Agent code and public APIs do not
depend on Hatchet types.

## Consequences

- Local dev and tests remain unchanged by default.
- Hatchet adoption is reversible per surface.
- The production migration can delete in-process coordination only after the
  Hatchet driver proves the equivalent behavior.
- The seam gives us a precise place to test the "with and without orchestrator"
  requirement.

## Non-Goals

- Do not split or redesign the APLRET modules.
- Do not store `MentalState` in Hatchet.
- Do not make Hatchet mandatory for agent authors.
