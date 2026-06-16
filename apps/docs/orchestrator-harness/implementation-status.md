# Implementation Status

Last updated: 2026-06-16.

## Stage

**Design + research complete. POC not started. No production code changed.**

This workspace was created after the research outcomes in
`apps/docs/drafts/orchestrator-substrate-requirements.md` (§13). The vendor
decision is open; Hatchet is the first POC candidate.

## Decisions captured (ADRs — all "Proposed")

- `adr/0001-kernel-seam-and-two-drivers.md` — shared kernel + `TurnExecutor` port
  + `InProcessRuntimeDriver` (default) and `HatchetRuntimeDriver` (opt-in).
- `adr/0002-durable-execution-mapping.md` — APLRET await loop ↔ Hatchet durable
  task (wait/spawn); the scheduled unit is a **segment** (`runLoop` to next
  durable boundary), not a single turn; token-provenance determinism rule.
- `adr/0003-timers-durable-sleep.md` — timers via durable sleep, not scheduled
  runs; `TimerReconciler` as defense-in-depth.
- `adr/0004-external-wakes-as-events.md` — `tasks/input`, tool/webhook, child
  completion become Hatchet events feeding durable event waits; hot chat stays
  in-process.
- `adr/0005-snapshot-ownership-and-idempotency.md` — `MentalState` stays in
  callAgent; **durable dedupe** required (CAS alone is insufficient against
  re-delivery); idempotency keys.
- `adr/0006-observability-and-deletion.md` — `driver_runs`, deep links to
  `TurnTrace`, outbox reconciliation, and the deletion/reversibility policy.
- `adr/0007-streaming-in-hatchet-mode.md` — keep the canonical stream contract;
  Hatchet mode requires a cross-process bus (NATS); do not use Hatchet's native
  `put_stream`.
- `adr/0008-conversation-triggered-wakes.md` — conversation transport stays out
  of scope; the resulting task wake enters via `enqueueResume`.
- `adr/0009-failure-retry-and-effect-idempotency.md` — per-effect idempotency
  keys (tool/outbox/child/timer), retry classification (throw = transient retry;
  `fail` = terminal), and the non-transactional outbox finding. **The
  correctness-critical ADR for Phase 2.**
- `adr/0010-cancellation-semantics.md` — boundary cancellation (no mid-segment
  preemption); intent authoritative in the snapshot.

## Specs drafted

- `specs/runtime-driver-port.md` — the `RuntimeDriver` + `TurnExecutor` seam.
- `specs/turn-executor-kernel.md` — the shared **segment** kernel contract
  (`runSegment`).
- `specs/hatchet-task-model.md` — Hatchet task definitions, metadata, keys.
- `specs/worker-runtime.md` — what a Hatchet worker process must construct
  (composition root, process-global hazards, cross-process bus).
- `specs/deletion-inventory.md` — line-referenced marked-for-deletion list.

## Production code added

- None yet.

## Production code changed

- None yet.

## Marked for deletion (pending POC + per-surface migration)

See `specs/deletion-inventory.md`. Nothing deleted yet. These are removed only
after the replacing Hatchet surface is proven and a reversible flag is in place.

## Tested

- Nothing yet. POC scenarios live in `harness/poc-scenarios.md`.

## Open questions (carried from requirements §11)

- Outbox: replace vs consume vs coexist (ADR 0006 proposes consume-then-retire).
- Hot-resume latency budget (ADR 0004; POC gate B8).
- One global worker pool vs per-tenant (requirements A5: start global).
- Reconciling Hatchet run UI with `TurnTrace` (ADR 0006: link, don't duplicate).
- Cross-process bus choice/provisioning for Hatchet mode (ADR 0007: NATS
  required; in-memory bus only for in-process driver).
- Durable dedupe shape: snapshot `processedKeys` vs `processed_wakes` table, and
  its pruning policy (ADR 0005).
- Transactional outbox: today `enqueueOutbox` and `writeSnapshotCAS` are separate
  non-transactional calls (confirmed in code). Decide whether to couple them for
  migrated event types or rely on per-effect idempotency (ADR 0009).
- Live cutover: tasks already waiting in-process (pending tokens / `setTimeout`)
  when a deployment flips to Hatchet mode — one-time adoption story (beyond the
  timer reconciler).
- Parity harness: golden canonical-event traces proving in-process and Hatchet
  drivers are equivalent (ADR 0007 parity test needs a home/format).

## Next action

Implement the kernel seam: `TurnExecutor` port + `InProcessRuntimeDriver`
extracted from today's `TaskEngine` behavior, proving D1/D5 (no type leakage;
in-process default tests unchanged) before any Hatchet wiring.
