# Migration Checklist

Use this when moving from this harness to production code. Mirrors the streaming
harness checklist style.

## Kernel seam (Phase 0)

- [x] Define `TurnExecutor.runSegment` port over `TaskExecutor`/`runLoop`
      (segment = run to next durable boundary; `continue` stays in-process).
- [x] Define `RuntimeDriver` port in `packages/core`.
- [x] Implement `InProcessRuntimeDriver` reproducing current behavior.
- [x] Inject driver at composition root; default in-process.
- [x] Extract shared bootstrap (agents/tools/plugins/memory/LLM/bus) reusable by
      a worker (`specs/worker-runtime.md`).
- [x] Full test suite passes unchanged (D5) — 170 suites / 936 tests green (2026-06-16).
- [ ] No orchestrator types above the adapter package (D1).
- [ ] `packages/core` public surface unchanged (type tests green).

## Hatchet adapter (Phases 1–4)

- [ ] Relevant `apps/docs/external/hatchet-docs/` pages read before each Hatchet
      task/SDK change (see `implementation-plan.md` § Hatchet docs); ADR summaries
      are not sufficient for API details.
- [ ] New `packages/driver-hatchet` workspace; no upward imports.
- [ ] Worker process builds full composition root + initializes `EngineLocator`
      for itself (`specs/worker-runtime.md`).
- [ ] Cross-process bus (NATS) provisioned; worker can publish stream events to
      the API host (ADR 0007).
- [ ] `aplret.outbox.dispatch` consumes outbox; in-process poll is fallback.
- [ ] `aplret.segment` child task = `runSegment` (run to next durable boundary).
- [ ] `aplret.task` durable loop: spawn → branch → wait/sleep/spawn → repeat;
      no `continue` crosses the boundary.
- [ ] Per-task concurrency key `tenantId:taskId`, limit 1.
- [ ] External + conversation wakes pushed as Hatchet events (ADR 0008); durable
      event waits resume.
- [ ] Timers via durable sleep; `TimerReconciler` implemented.
- [ ] `driver_runs` table + composite metadata keys.

## Idempotency & ordering

- [ ] Wake idempotency keys defined for start/input/tool/child/timer/outbox.
- [ ] **Durable** dedupe implemented (snapshot `processedKeys` or
      `processed_wakes` table), committed atomically with the snapshot (ADR 0005).
- [ ] **Per-effect** idempotency keys defined (ADR 0009): tool
      `taskId:turnSeq:toolCallId`, outbox `taskId:turnSeq:eventKind`, child
      `parentTaskId:token:childTaskId`, timer `taskId:token:timerId`.
- [ ] Retry classification implemented: `throw` = transient retry (bounded
      attempts + backoff); `fail` boundary = terminal, never retried (ADR 0009).
- [ ] Transactional-outbox decision made: couple `enqueueOutbox` with
      `writeSnapshotCAS` for migrated event types, or rely on per-effect
      idempotency (today they are separate, non-transactional calls).
- [ ] Duplicate/redelivered delivery proven no-op at the effect boundary —
      including across a crash between apply and ack, and after a partial
      mid-segment crash (not CAS alone).
- [ ] `processedKeys` pruning policy defined.
- [ ] FIFO per `taskId` verified.

## Cancellation (ADR 0010)

- [ ] Cancellation intent written authoritatively to the snapshot.
- [ ] Pending-token wakes become durable no-ops after cancel.
- [ ] Queued Hatchet runs cancelled best-effort; running segment finishes its
      current effect boundary (no mid-segment kill).
- [ ] `cancel` idempotent (`taskId:cancel`); cancel-after-complete is a no-op.

## Parity & cutover

- [ ] Parity harness asserts identical canonical event traces under in-process
      vs Hatchet drivers (ADR 0007) before any deletion.
- [ ] Live cutover drill: deployment with in-flight waits flips to Hatchet with
      no lost wakes/timers and no duplicate effects.

## Observability

- [ ] Run metadata carries `tenantId/agentId/taskId/traceId/token/operation`.
- [ ] Deep link Hatchet run → callAgent task → `TurnTrace`.
- [ ] Prometheus/OTel wired; alerts for DLQ/stuck/failure/timer-lag.
- [ ] Retention policy decided (Hatchet ~30d; audit stays in TurnTrace/snapshots).

## Deletion (guarded, per surface)

- [ ] Outbox poll loop retired for migrated event types.
- [ ] `resumeInput` / `handleToolCompleted` / `handleExternalEventOccurred`
      auto-resume paths removed in Hatchet mode.
- [ ] Child-completion CAS/resume retry loops removed.
- [ ] `childCompletionInFlight`, `LoopRegistry` injection, `queueMicrotask`
      deferral removed.
- [ ] `setTimeout` token-expiry waits removed.
- [ ] Each deletion verified reversible (flag flip restores in-process path).

See `specs/deletion-inventory.md` for exact line references.

## POC gates (from requirements §13)

- [ ] B1 crash mid-segment safe (one effective transition via durable dedupe).
- [ ] B2 timer survives restart (durable sleep + reconciler).
- [ ] B3 duplicate resume no-op.
- [ ] B4 per-task serialization.
- [ ] B5 operator search by IDs.
- [ ] B6 failed-run replay/cancel/inspection.
- [ ] B7 self-hosted dashboard parity (incl. security sub-gates).
- [ ] B8 hot-resume latency protected.
- [ ] B9 child fan-out/fan-in.
- [ ] B10 upgrade with active timers/runs (production gate).

## Docs promotion

- [ ] Promote accepted ADRs (0001–0010) into permanent architecture docs.
- [ ] Promote driver seam + Hatchet model + worker runtime into permanent
      contract docs.
- [ ] Promote the ADR 0007 streaming-parity decision into the canonical streaming
      contract doc.
- [ ] Convert POC scenarios into permanent tests.
- [ ] Delete `apps/docs/orchestrator-harness/` after promotion or discard.
