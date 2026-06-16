# Orchestrator Substrate Design Principles

## Core model

The orchestrator is **infrastructure under cognition**, never cognition itself.
It schedules, waits, serializes, retries, and makes work durable and observable.
The APLRET loop remains the brain.

callAgent emits a single durable unit of progress — **one segment** — and a typed
boundary (`await_input` / `await_tool` / `await_child` / `sleep` / `complete` /
`fail`). A segment is one `runLoop` execution advanced to the next durable
boundary; internal `continue` turns run in-process and never cross the driver
boundary (ADR 0002). The orchestrator's only job is to decide *when the next
segment runs* and *what wakes it*, durably.

## Principles

1. **One shared kernel.** `oneTurn` / `runLoop` / modules / `MentalState`
   snapshots / canonical stream events are shared and unchanged across drivers.
2. **Two drivers behind one seam.** `InProcessRuntimeDriver` (default) and
   `HatchetRuntimeDriver` (opt-in) implement the same kernel seam.
3. **A segment is an opaque, non-deterministic unit.** It runs as a Hatchet child
   / regular task, never as durable workflow code. Internal `continue` turns stay
   in-process (no Hatchet round-trip per turn).
4. **Durable control, callAgent cognition.** The orchestrator may own runtime
   control state (which wait we are on); `MentalState` lives only in callAgent
   snapshots. (Consistent with the framework's own "separate reasoning state from
   runtime control state" rule.)
5. **At-least-once in, idempotent out (durable dedupe).** Every driven unit is
   keyed by an existing identifier (`taskId`, `token`, `traceId`) and is safe to
   deliver more than once. CAS guards *concurrent* writes; it does **not** stop
   *sequential* duplicate delivery. A **durable** dedupe (a processed-key record
   persisted with the snapshot or in a DB table) is therefore mandatory before
   Hatchet mode is used outside local POC. The in-memory RPC idempotency store is
   not sufficient. (ADR 0005.)
6. **Native primitives over hand-rolled ones.** Prefer durable sleep, durable
   event waits, and child spawning over `setTimeout`, poll loops, and in-process
   resume coordination.
7. **Works with and without the orchestrator.** The default in-process path runs
   with zero new infrastructure; the orchestrator is opt-in per deployment.
8. **Reversible per surface.** Each migrated surface (timers, outbox, resume,
   children) can fall back to in-process via configuration.
9. **No orchestrator types leak upward.** Agent authors and the public package
   surface never import orchestrator types; wiring is at the composition root.
10. **Small payloads.** Orchestrator messages carry IDs + minimal event data;
    large data stays in artifacts/snapshots.
11. **Observability links, not duplicates.** Orchestrator run history links to
    `TurnTrace` and telemetry; it does not become a second cognition log.
12. **Delete by evidence.** Hand-rolled coordination is marked for deletion, but
    removed only after the replacing surface is proven and reversible.

## Non-negotiables

- The APLRET loop, module contracts, and `MentalState` snapshot shape are not
  refactored by this work.
- A segment never runs inside Hatchet durable workflow code (P4 / determinism).
- `MentalState` is never stored in the orchestrator.
- The canonical streaming contract is unchanged; Hatchet mode delivers stream
  events over a cross-process bus, not Hatchet's native stream (ADR 0007).
- The full test suite and local dev run on the in-process driver with no external
  services.
- Duplicate wake delivery must be a durable no-op at the effect boundary, not
  merely CAS-protected (ADR 0005).
- No public `any`; Zod-first; closed discriminated unions for any new contracts.
- Interactive chat/SSE latency is protected: a durable hop must not be forced
  onto hot resumes (see ADR 0004 and requirements R-N1).

## Mapping summary (APLRET ↔ Hatchet)

| APLRET fact | Hatchet-native primitive | Notes |
|---|---|---|
| run one segment (LLM/tools; internal `continue` in-process) | child / regular task | non-deterministic; never durable code |
| `await_input` | durable event wait | event key derived from a token minted by the segment |
| `await_tool` | durable event wait or child task | tool may run as child task |
| `await_child` | child spawning + wait | fan-out/fan-in native |
| sleep / token expiry | durable sleep | survives restarts (ADR 0003) |
| per-task single-writer | concurrency key `tenantId:taskId`, limit 1 | replaces in-process locks |
| tenant fairness | Group Round Robin on `tenantId` | |
| status/progress | task status events + canonical stream | outbox reconciled (ADR 0006) |
| terminal `complete`/`fail` | durable task returns | |
