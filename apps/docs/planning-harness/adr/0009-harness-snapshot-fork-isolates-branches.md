# ADR 0009: Harness Snapshot Fork Isolates Branches

## Status

Accepted

Implementation contract: `specs/harness-snapshot-fork.md`.

## Context

The originating request wanted `harness.snapshot()` / `fork()` so tests
can branch repair vs retry from one failure point, plus controlled clock
and RNG.

`createTestHarness` already has `seedMentalState`, traces,
`deterministicTime` (default true), invite clock pins, and token seeding.
It does **not** snapshot the full harness state or deep-clone into two
isolated instances.

Production `Snapshot` in `loop/types.ts` is the resume document (`M`,
pending, meta). A **test** snapshot is richer (inbox, traces, stubs,
clock). Do not overload the production type.

`oneTurn.ts` still uses `Math.random` when Policy returns an array
(`policyParams.stochastic`). Fork reproducibility for that path needs an
injectable RNG, not a global `Math.random` monkeypatch as the API.

## Decision

- Add `harness.snapshot(): HarnessSnapshot` and
  `createTestHarness(...).fork(snapshot)` **or**
  `harness.fork(snapshot): TestHarness` that returns a **new** harness.
- Deep-clone so mutations in branch A cannot be observed in branch B
  (`currentM()`, pending, inbox, traces, stub queues).
- Do not share `ctx`, `MemoryWriter` buffers, or module closures that
  hold mutable agent state — modules are re-bound per harness; if a test
  passes a stateful module object, that is the test’s bug (document it).
- Production `Snapshot` type unchanged.
- Clock: keep `deterministicTime`; copy invite-clock pin into the fork.
- RNG: optional `randomSeed` on `HarnessConfig`. When set, Policy-array
  sampling in the loop uses a seeded PRNG. When unset, behavior stays as
  today (`Math.random`). Do not seed globally for all tests by default.
- ID/token generators: `seedTokens` already exists; copy the harness
  token state into the snapshot if tokens are deterministic.

## Consequences

- Scenario 8 becomes an automated isolation test.
- Repair-policy A/B tests do not need two full re-seeds by hand.
- Stateful custom modules remain a documented pitfall.

## Non-Goals

- Do not add snapshot fork to production runtime resume.
- Do not make `Math.random` seeded process-wide.
- Do not serialize module functions into the snapshot.
