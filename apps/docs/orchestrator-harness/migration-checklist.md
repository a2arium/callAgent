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
- [x] New `packages/driver-hatchet` workspace; no upward imports.
- [x] Worker process builds full composition root + initializes `EngineLocator`
      for itself (`specs/worker-runtime.md`). *(Phase 1 worker is outbox-only.)*
- [x] Cross-process bus (NATS) provisioned; worker can publish stream events to
      the API host (ADR 0007).
- [x] `aplret.outbox.dispatch` consumes outbox; in-process poll is fallback.
- [x] `aplret.segment` child task = `runSegment` (run to next durable boundary).
- [x] `aplret.task` durable loop: spawn → branch → wait/sleep/spawn → repeat;
      no `continue` crosses the boundary.
- [ ] Per-task concurrency key `tenantId:taskId`, limit 1.
- [x] Child wakes pushed as Hatchet events; `await_child` durable event waits
      resume and recover from already-persisted child completion/failure events.
- [x] External event wakes pushed as Hatchet events; `await_event` durable event
      waits resume.
- [ ] Conversation wakes have runtime-seam coverage, but remain delegated until
      a first-class durable conversation wait boundary exists (ADR 0008).
- [ ] Timers via durable sleep; `TimerReconciler` implemented.
- [x] `driver_runs` table + composite metadata keys.

## Idempotency & ordering

- [x] Wake idempotency keys defined for start/input/tool/child/external/timer/outbox.
      Current keys are documented in ADR 0005.
- [x] **Durable** dedupe implemented (snapshot `processedKeys` or
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
- [x] `processedKeys` pruning policy defined.
- [ ] FIFO per `taskId` verified.

## Cancellation (ADR 0010)

- [x] Cancellation intent written authoritatively to the snapshot.
- [x] Pending-token wakes become durable no-ops after cancel.
- [x] Queued Hatchet runs cancelled best-effort; running segment finishes its
      current effect boundary (no mid-segment kill).
- [x] `cancel` idempotent (`taskId:cancel`); cancel-after-complete is a no-op.

## Parity & cutover

- [ ] Parity harness asserts identical canonical event traces under in-process
      vs Hatchet drivers (ADR 0007) before any deletion.
- [ ] Live cutover drill: deployment with in-flight waits flips to Hatchet with
      no lost wakes/timers and no duplicate effects.

## Production readiness

See `production-readiness.md`. These items must pass before Hatchet mode becomes
the default production driver or before the operator viewer becomes the primary
production incident UI.

- [ ] Semantic run summary/read model exists and is backfilled for existing
      `driver_runs`/`wm_events` where needed.
- [ ] Root-vs-child classification and child counts come from persisted run/edge
      facts, not bounded recent-event samples.
- [ ] Fleet and graph query plans reviewed with `EXPLAIN ANALYZE` against
      realistic data; required indexes are present.
- [ ] 100k-run operator load test passes with 20 active roots and realistic child
      fan-out/event volume.
- [ ] Run graph APIs enforce caps/progressive loading for large trees.
- [ ] Retention and archival policy implemented for Hatchet provider rows,
      semantic summaries, `driver_runs`, `wm_events`, logs, TurnTrace refs, and
      artifacts.
- [ ] Worker/tenant/agent/tool/browser/LLM concurrency limits configured and
      documented.
- [ ] Agent budget timeouts are passed to Hatchet with fallback and grace.
- [ ] Queue-age, wait-age, missing-child, timeout, and cancellation behaviors are
      visible and tested.
- [ ] Snapshot/event/metadata/log/API payload budgets are enforced; large content
      remains artifact refs until the consumer boundary.
- [ ] Payload-budget failures appear in agent summary, turn summary, logs, and
      graph nodes with readable code/message.
- [ ] Logs, metrics, alerts, and deep links are wired for semantic run graph,
      Hatchet provider runs, TurnTrace, artifacts, and LLM traces.
- [ ] Hatchet/log sink outage does not hide the original runtime error or create
      unbounded retry noise.
- [ ] Operator UI defaults to root runs only, with an explicit include-children
      switch.
- [ ] Live operator polling backs off, pauses in hidden tabs, and slows/stops
      after terminal status.
- [ ] Production mode is explicit from runtime configuration; development mode
      is the default.
- [ ] Auth and tenant isolation are implemented and tested before production data
      is exposed.
- [ ] Failure drills pass: worker kill mid-segment, worker kill while awaiting
      child, Hatchet unavailable, Postgres restart, NATS unavailable, missing
      child wake, timeout, and cancellation.

## Observability

- [ ] Run metadata carries `tenantId/agentId/taskId/rootTaskId/traceId/token/operation`.
- [ ] `GET /tasks/:taskId/run-graph` returns the semantic operator graph:
      root `AgentRun`, child `AgentRunEdge` entries, `TurnRun`, hidden-by-default
      `EffectRun`, grouped events/logs, TurnTrace refs, and raw provider ids.
- [ ] `driver_runs` is treated as backend/provider debug data, not the product
      operator model.
- [ ] Normalized durable graph persistence is implemented or explicitly deferred:
      `agent_runs`, `agent_run_edges`, `turn_runs`, `effect_runs`.
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
- [ ] B5 operator search by IDs and/or semantic run graph.
- [ ] B6 failed-run replay/cancel/inspection.
- [ ] B7 self-hosted dashboard works as debug infra, while semantic run graph
      answers product/operator questions (incl. security sub-gates).
- [ ] B8 hot-resume latency protected.
- [x] B9 child fan-out/fan-in durable-parent unit coverage: child completes after
      wait, child completed before wait, child failure, out-of-order child
      completion selection, missing child wake timeout, and graph projection.
      Verified again in the 2026-06-22 broad Phase 3 regression sweep.
- [ ] B10 upgrade with active timers/runs (production gate).
- [ ] B11 100k-run volume test with dashboard/query/retention acceptance.

## Docs promotion

- [ ] Promote accepted ADRs (0001–0010) into permanent architecture docs.
- [ ] Promote driver seam + Hatchet model + worker runtime into permanent
      contract docs.
- [ ] Promote the ADR 0007 streaming-parity decision into the canonical streaming
      contract doc.
- [ ] Promote `apps/docs/operator-run-graph.md` as the permanent operator-facing
      orchestration contract.
- [ ] Promote `apps/docs/orchestrator-harness/production-readiness.md` into the
      permanent production operations/runbook docs.
- [ ] Convert POC scenarios into permanent tests.
- [ ] Delete `apps/docs/orchestrator-harness/` after promotion or discard.
