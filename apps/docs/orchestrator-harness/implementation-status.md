# Implementation Status

Last updated: 2026-06-16.

## Stage

**Phase 0 scaffold complete** — kernel seam, driver routing, composition bootstrap,
Scenario 0 parity test, and D5 full-suite gate passed (170 suites / 936 tests).
Hatchet POC not started.

This workspace was created after the research outcomes in
`apps/docs/drafts/orchestrator-substrate-requirements.md` (§13). Hatchet is the
first POC candidate.

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
- `specs/driver-sync-api.md` — sync vs async driver API (Phase 0 shim vs Hatchet).
- `specs/composition-roots-scope.md` — which entry points use shared bootstrap.
- `specs/child-completion-routing.md` — why `handleChildCompleted` stays on
  `executeTurn` until Phase 2.

## Production code added

- Phase 0.1 (kernel seam, additive):
  - `packages/core/src/runtime/runtimeDriver.ts` — `RuntimeDriver` scheduling
    port + wake/ids types.
  - `packages/core/src/runtime/turnExecutor.ts` — `TurnExecutor` segment port,
    `SegmentBoundary`/`SegmentResult`, and pure `outcomeToBoundary` /
    `boundaryToTaskStatus` mappers.
  - `packages/core/src/runtime/inProcessRuntimeDriver.ts` — `InProcessRuntimeDriver`
    (immediate background segments, local timers, child/outbox delegation).
  - `packages/core/src/runtime/index.ts` — internal barrel (NOT re-exported from
    the public package index, so the public surface is unchanged — D1).
  - Tests: `packages/core/tests/runtime/outcomeToBoundary.test.ts`,
    `inProcessRuntimeDriver.test.ts` (15 tests).

- Phase 0.2 (`TurnExecutor` backed by real `TurnRunner.runTurn`):
  - `packages/core/src/runtime/segmentWakeApplicator.ts` — applies wakes to
    snapshot before `runTurn` (mirrors TaskEngine prep paths).
  - `packages/core/src/runtime/inMemorySegmentDedupe.ts` — in-process idempotency.
  - `packages/core/src/runtime/turnRunnerSegmentExecutor.ts` — `TurnExecutor`
    wrapping `TurnRunner.runTurn` + wake applicator.
  - Tests: `segmentWakeApplicator.test.ts`,
    `turnRunnerSegmentExecutor.integration.test.ts` (start → await_input →
    resume → complete; duplicate idempotency key no-op). **21 runtime tests green.**

- Phase 0.3 (composition-root injection — **done**):
  - `packages/core/src/runtime/buildInProcessRuntimeStack.ts` — wires
    `TurnRunnerSegmentExecutor` + `InProcessRuntimeDriver`.
  - `TaskEngine` constructor builds/holds default `runtimeDriver`; optional
    `opts.runtimeDriver` override for tests/future Hatchet adapter.
  - `waitForBackgroundTasks` also drains `InProcessRuntimeDriver.waitForIdle()`.
  - Wake/scheduling paths routed through `runtimeDriver`:
    - `startTask` → `enqueueStartSync` (sync await via `prepared` turn invocation)
    - `resumeInput` → `enqueueResumeSync` (`input` wake, idempotency
      `${taskId}:input:${token}`)
    - `handleToolCompleted` → `enqueueResumeSync` (`tool` wake)
    - `handleExternalEventOccurred` → `enqueueResumeSync` (`external` wake)
    - `ensureConversationActivation` → `enqueueResumeSync` (`conversation` wake)
  - `PreparedTurnInvocation` on `RunSegmentParams` preserves exact pre-mutated
    ctx/snapshot semantics (no double applicator mutation).
  - **Deferred:** `handleChildCompleted` still calls `TaskExecutor.executeTurn`
    directly (~2656); background `enqueueStart`/`enqueueResume` (fire-and-forget)
    not yet used by TaskEngine call sites.

- Phase 0.4 (shared composition bootstrap — **done**):
  - `packages/core/src/runtime/bootstrapCompositionRoot.ts` — single bootstrap for
    API host and future worker: `TaskEngine` + event bus + `EngineLocator` +
    optional `registerAgents` hook.
  - `bootstrapCompositionRoot` exported from public `@a2arium/callagent-core`
    index (no orchestrator types on public surface — D1).
  - `bootstrapCompositionRootInternal` + full runtime barrel on
    `@a2arium/callagent-core/unstable` for worker/driver packages.
  - `TaskEngine.getCompositionRuntimeDriver()` + `InProcessRuntimeDriver.getTurnExecutor()`
    for composition-root access.
  - `apps/examples/runtime-host/src/server.ts` migrated to shared bootstrap.
  - Tests: `bootstrapCompositionRoot.test.ts` (4 tests). **25 runtime tests green.**

- Phase 0 review follow-ups (**done**):
  - `isSyncRuntimeDriver()` duck-type guard replaces `instanceof` in routing.
  - POC Scenario 0 automated: `scenario0.inProcessParity.test.ts`.
  - Driver routing tests: `taskEngineDriverRouting.test.ts`.
  - `runnerCli` migrated to `bootstrapCompositionRoot`.
  - ADR 0001 updated to segment terminology.

## Production code changed

- `packages/core/src/orchestration/taskEngine.ts` — holds default
  `InProcessRuntimeDriver` at composition root; routes start/resume/tool/
  external/conversation wakes through `enqueueStartSync` / `enqueueResumeSync`.
- `packages/core/src/runtime/inProcessRuntimeDriver.ts` — sync segment await
  (`runSegmentAwait`, `enqueueStartSync`, `enqueueResumeSync`).
- `packages/core/src/runtime/turnExecutor.ts` — `PreparedTurnInvocation` +
  optional `taskEntity` on `SegmentResult`.
- `packages/core/src/unstable.ts` — exports internal runtime composition +
  runtime seam barrel for worker bootstrap.
- `apps/examples/runtime-host/src/server.ts` — uses `bootstrapCompositionRoot`.

## Marked for deletion (pending POC + per-surface migration)

See `specs/deletion-inventory.md`. Nothing deleted yet. These are removed only
after the replacing Hatchet surface is proven and a reversible flag is in place.

## Tested

- `packages/core/tests/runtime/*` — 29 tests (mapper, driver, wake applicator,
  segment executor, bootstrap, Scenario 0 parity, driver routing).
- `TaskEngine.sync`, `TaskEngine.inbox`, `TaskEngine.async_race` — pass with
  driver-routed call sites.
- All `packages/core/tests/TaskEngine*` suites — pass (151 tests).
- **D5:** full monorepo suite — 170 passed, 936 tests, 2 skipped (2026-06-16).

## Next action

Phase 0 scaffold + D5 are done. Next: Phase 1 Hatchet outbox dispatch
(`packages/driver-hatchet`). Child completion routing deferred per
`specs/child-completion-routing.md` until Phase 2 prerequisites.

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

