# Implementation Status

Last updated: 2026-06-26.

## Stage

**Phase 2 durable loop + Operator Experience MVP implemented; Phase 3
external-wake, child fan-in, cancellation, and operator-hardening slice closed
for harness purposes; Phase 4 durable timers/restart hardening implemented and
validated for harness purposes; production-readiness track remains the promotion
gate.**
Hatchet-backed
`aplret.outbox.dispatch`, `aplret.segment`, and `aplret.task` / `agent.<agentId>`
parent workflows exist behind driver-surface flags. The runtime now exposes a
projection-backed operator `AgentRunGraph` API so users can inspect agents, child
calls, turns, effects, events/log groups, TurnTrace refs, and raw Hatchet ids
without reading `aplret.*` workflow names. The product track now adds compact
`wm_events` cognition capture, a fleet list API, memory/turn detail APIs, and a
Vite/React operator viewer served at `/operator` by `runtime-host` when built.

The current operator viewer is good enough for MVP investigation and real-run
hardening, but it is not yet the production-scale read path. Production readiness
now has a dedicated plan in `production-readiness.md`, covering indexed summary
storage, root/child correctness, graph caps, payload budgets, observability,
retention, load tests, and failure drills.

Current Phase 3 status: durable child wakes have the required unit coverage for
post-wait child completion, pre-wait persisted child completion/failure,
out-of-order child completion selection, missing child wake timeout, and graph
projection. Input/tool durable waits are implemented, and external events now
have a first-class `await_event` boundary backed by `aplret.external.<token>`
Hatchet events. Boundary cancellation now has a durable snapshot intent,
pending-token late wakes no-op as `canceled` boundaries, idempotent
cancel-after-terminal behavior, and best-effort provider-run cancellation from
recorded `driver_runs` provider ids. Recent real-run hardening closed the main
operator correctness gaps found while running `discover-listing-selectors`:
root-only fleet filtering uses child-link facts rather than stale provider
parent columns, workspace agent discovery no longer depends on stale
`agent-paths.json`, resumed runs are treated as active when newer running
segments supersede worker-abort root rows, and live run graphs show started
event-only turns before their final `turn.completed` trace is captured.

Phase 4 is now closed enough for harness purposes: timer facts are durable,
Hatchet timer fires are idempotent, the startup/periodic reconciler repairs
overdue timers, cancellation propagates coherently through child/parent graphs,
and manual restart/cancel drills no longer leave stale waiting/running operator
state. Remaining work around normalized read-model persistence, query/index
validation, retention, production-grade observability, payload budgets, and
volume/failure drills is tracked as Phase 5 production readiness, not as a Phase
4 blocker.
Phase 5 local readiness evidence now includes persisted 100k semantic API
checks, a 20-poller profile/fix, active parent/child drills, runtime/Hatchet/NATS
/Postgres interruption drills, and a browser operator stale-state proof for the
Postgres-interruption run. The remaining promotion evidence is hosted/staging
validation, live provider-enqueue evidence, and the final observability export
decision.
Conversation activation still has runtime-seam coverage only and remains a
follow-up until the kernel has a first-class conversation boundary.

Manual POC gates B5–B7 are **signed off** via `apps/hatchet-poc/README.md`.
The Phase 2 parent-child DAG signoff is also complete: `phase2-parent-agent`
delegates to `phase2-loop-agent` in Hatchet mode and the graph renders one root
agent node, one child agent node, one completed `delegates_to` edge, grouped
child events, turn details, and hidden debug effect rows. The remaining UX
hardening is durable normalized graph persistence (`agent_runs`,
`agent_run_edges`, `turn_runs`, `effect_runs`) and operator actions once ADR 0010
lands. Hatchet UI grouping is useful debug scaffolding, not the product surface.

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
  callAgent; **durable wake dedupe** uses bounded snapshot `processedKeys`
  stamped into active segment snapshot writes; idempotency keys.
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
- `specs/timer-wakes.md` — Phase 4 durable timer/sleep/reconciler contract and
  B2 acceptance.
- `specs/worker-runtime.md` — what a Hatchet worker process must construct
  (composition root, process-global hazards, cross-process bus).
- `specs/deletion-inventory.md` — line-referenced marked-for-deletion list.
- `specs/driver-sync-api.md` — sync vs async driver API (Phase 0 shim vs Hatchet).
- `specs/composition-roots-scope.md` — which entry points use shared bootstrap.
- `specs/child-completion-routing.md` — why `handleChildCompleted` stays on
  `executeTurn` until Phase 2.
- `specs/operator-viewer.md` — operator viewer data sources, event taxonomy,
  endpoints, SPA contract, and acceptance.
- `specs/production-readiness-gates.md` — Phase 5 production-readiness contract:
  semantic read model, query/index gates, payload budgets, observability,
  failure drills, retention, security, and deletion gates.
- `../operator-run-graph.md` — permanent semantic operator graph contract.
- `production-readiness.md` — production promotion workstreams, gates, and
  scale/observability/payload/readiness criteria.

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

- Phase 1 (Hatchet outbox dispatch — **done**):
  - `packages/core/src/eventbus/outboxDispatch.ts` — shared dispatch helpers +
    hatchet topic flags; `OutboxPublisher` refactored to use them.
  - `SessionManager.setOnOutboxEnqueued` + row id return from `enqueueOutbox`.
  - `packages/driver-hatchet` — `HatchetRuntimeDriver` (delegating wrapper),
    `aplret.outbox.dispatch` task, `driver_runs` repository, bootstrap helper.
  - `driver_runs` Prisma model + migration (`packages/memory-sql`).
  - `apps/hatchet-worker` — minimal outbox worker entry point.
  - `apps/hatchet-poc/` — Docker Compose (Hatchet + NATS; host Postgres for both DBs)
    + manual runbook.
  - `apps/examples/runtime-host` — opt-in hatchet outbox mode via env flags.
  - Tests: `outboxDispatch.test.ts`, `packages/driver-hatchet/tests/*`.
  - Phase 1 hardening (review follow-up):
    - `traceId` / `agentId` / `token` threaded from outbox payload → Hatchet metadata.
    - Terminal Hatchet failure dead-letters + deletes outbox row (no poison rows).
    - Inline dispatch fallback when `runNoWait` trigger fails.
    - `driver_runs.provider_run_id` unique + Prisma upsert.
    - Known limitation: publish-then-delete may duplicate events on Hatchet redelivery
      until ADR 0009 per-effect idempotency (Phase 2).
    - SDK V1 import cleanup: `packages/driver-hatchet` imports from
      `@hatchet-dev/typescript-sdk/v1/*` (explicit file subpaths) to drop the
      `HATCHET_V0_REMOVED` deprecation warning; POC Hatchet env consolidated to the
      repo-root `.env` (`hatchet:poc:up` uses `--env-file .env`).

- Phase 1 manual POC gate signoff (host Postgres + Docker Hatchet/NATS):
  - **B5 baseline dispatch — PASS.** One demo task produced N `aplret.outbox.dispatch`
    runs (one per outbox row), all succeeded; `outbox` drained to 0 for the task;
    `conversation_dead_letter` empty; `driver_runs` has matching `completed` rows
    linked by `task_id` + `trace_id`.
  - **B5 metadata search — PASS.** Runs carry `tenantTaskKey`, `tenantTraceKey`,
    `traceId`, `taskId`, `tenantId`, and `token` (on `task.input_required`) and are
    filterable in the dashboard.
  - **B6 replay — PASS.** Induced replay/failure scenario recovered correctly from
    the Hatchet UI.
  - **B7 self-hosted UI — PASS with Phase 2 caveat.** Dashboard is useful for
    Phase 1 replay/errors/runs/metadata, with the agreed limitation that raw
    outbox-dispatch runs are not automatically grouped until the Phase 2
    `aplret.task` parent-run model.
  - **Run grouping — resolved as infrastructure, superseded by operator graph UX.**
    Dispatch runs are nested under the durable parent when routed through
    `aplret.task` / `agent.<agentId>`. The accepted product direction is the
    callAgent `AgentRunGraph`, not the raw Hatchet run list (see
    `../operator-run-graph.md` and `specs/hatchet-task-model.md` § Run grouping).
  - **Metadata follow-up — resolved in Phase 2 slice:** `agentId` is threaded into
    outbox payload / dispatch context where available, and semantic graph
    projection treats missing raw provider metadata as debug incompleteness rather
    than a product-model failure.

- Operator graph slice:
  - `packages/core/src/operator/runGraph.ts` — `AgentRunGraph`, `AgentRun`,
    `AgentRunEdge`, `TurnRun`, `EffectRun`, and grouped `AgentRunEvent`
    projection from existing runtime data.
  - `GET /tasks/:taskId/run-graph` — JSON/API signoff surface.
  - `apps/examples/phase2-parent-agent` — canonical parent DAG signoff agent
    that calls `phase2-loop-agent`.
  - Hatchet metadata normalized around `agent.run`, `turn.segment`, and
    `effect.outbox.dispatch`, with `rootTaskId` where available.
  - Known registered agents can register `agent.<agentId>` parent workflows;
    `aplret.task` remains the fallback.
  - Phase 2 hardening persists graph-critical fields on `driver_runs`:
    `rootTaskId`, parent/child ids, edge token/kind, turn sequence, boundary
    kind, and TurnTrace id where available.
  - Remaining hardening: persist normalized graph records rather than using
    `driver_runs` as the bridge table.

- Operator Experience track:
  - `observability.turnTrace.enabled/level` now gates compact operator capture.
  - `turn.completed` events capture stage, decision, transition, timings, usage,
    LLM metadata, child summaries, and trace/span refs into existing `wm_events`.
  - `memory.read`, `memory.write`, and `memory.delete` events capture key-level
    memory activity without storing memory values.
  - `AgentRunGraph` now includes `memoryOps`, per-turn cognition, per-turn LLM
    metadata, and memory operation timelines.
  - `GET /agent-runs` lists root runs with tenant scoping, filters, and keyset
    pagination over `driver_runs`.
  - `GET /tasks/:taskId/turns/:turnSeq` and `GET /tasks/:taskId/memory` expose
    read-only drill-down details.
  - `driver_runs` has list-oriented indexes for tenant/time, tenant/agent/time,
    and tenant/status/time.
  - `apps/operator-viewer` is a Vite/React SPA with a virtualized fleet table,
    React Flow DAG, turn/LLM/memory/effects drawers, and Hatchet/Opik deep links.
  - `apps/examples/runtime-host` serves the built viewer at `/operator` when
    `apps/operator-viewer/dist/index.html` (or `OPERATOR_VIEWER_DIST`) exists.

- Phase 4 durable timers and restart hardening:
  - `runtime_timers` persisted timer facts back token-expiry and sleep waits.
  - Hatchet mode schedules timer wakes through `aplret.timer.fire` with stable
    idempotency keys, fire leases, and duplicate/late no-op handling.
  - `TimerReconciler` scans overdue scheduled timers on worker startup and
    periodically, so downtime through `dueAt` is repaired by enqueueing the
    same idempotent timer fire.
  - Cancel requests cancel pending task timers best-effort and late timer fires
    observe canceled/no-longer-pending state as success no-ops.
  - Operator graph projection exposes timer schedule/fire effects and keeps
    resumed runs active when newer running segments supersede stale provider
    abort/root rows.
  - Operator cancel controls call the runtime cancel API for root and selected
    agent runs; canceled child agents notify their A2A parent via
    `handleChildFailed`, and Hatchet parents schedule an async resume so the
    graph converges instead of leaving parents waiting forever.

- Production-readiness findings (added 2026-06-21):
  - 10-20 active parallel agent tasks is a realistic target once Hatchet worker
    concurrency, external tool/browser pools, LLM provider limits, and DB pool
    sizes are configured.
  - 100k historical runs is not a guaranteed property of the current read path.
    It requires summary/graph persistence, query/index validation, retention, and
    a recorded load test.
  - Fleet root/child filtering must stop depending on bounded recent event
    samples; persisted run/edge facts need to answer root vs child and child
    counts.
  - Run graph detail currently reads recursive task/session/event data. It needs
    graph caps and progressive loading before large fan-out trees are supported.
  - Polling every few seconds is acceptable for the MVP, but production needs
    adaptive intervals, hidden-tab pause, terminal-status slowdown, and
    server-side query budgets.
  - Payload size failures such as snapshot-too-large must be first-class
    semantic errors in summaries, turns, logs, and graph nodes. Artifacts should
    remain refs until the consumer boundary that needs content resolves them.
  - Hatchet/log connectivity failures must not replace the original runtime
    failure or create retry storms.

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

- 2026-06-22 broad Phase 3 regression sweep:
  `yarn test packages/core/tests/runtime packages/core/tests/operator.runGraph.test.ts packages/core/tests/taskEngine.coverage.test.ts packages/core/tests/taskEngine.enhanced.coverage.test.ts packages/core/tests/taskEngine.additional.coverage.test.ts packages/core/tests/taskEngine.coverage.improvement.test.ts packages/core/tests/a2a.asyncChildPrematureCompletion.repro.test.ts packages/driver-hatchet/tests --runInBand`
  — 25 suites / 233 tests passed after non-child wake routing coverage was
  added. Expected console noise remains from tests that
  intentionally drive failed stores, Hatchet trigger failures, and dispatch
  fallback paths.
- 2026-06-23 Phase 3 hardening commits:
  - `846bfa2` / `f35035f` — operator agent registry and root/child fleet scope
    against real `itupdated` workspace data.
  - `740aaf4` — durable wake dedupe policy closure.
  - `ec3fd50`, `2993c70`, `6e5f0d7` — cancellation semantics, idempotent
    cancel-after-terminal behavior, and provider-run best-effort cancellation.
  - `33c94b8` — resumed runs with stale worker-abort root rows remain active
    when newer running turn segments exist.
  - `4361cd1` — live operator graph turn nodes via `turn.started` projection and
    temporal child-edge matching.
- 2026-06-23 focused verification:
  - `yarn test packages/core/tests/operator.agentRunsList.test.ts packages/core/tests/operator.runGraph.test.ts --runInBand`
    — root/child fleet scope, stale parent-row status, live turn projection, and
    graph edge projection coverage.
  - `yarn test packages/core/tests/operator.runGraph.test.ts --runInBand`
    — 12 graph projection tests passed after live-turn projection was added.
  - `yarn workspace @a2arium/operator-viewer build` — viewer build passes after
    graph polling/edge changes. Vite still reports the known large
    bundle/chunk-size warning.
  - `yarn workspace @a2arium/callagent-core build` — core build passes.
- 2026-06-24 Phase 4 hardening verification:
  - `yarn jest packages/core/tests/taskEngine.coverage.test.ts packages/core/tests/operator.runGraph.test.ts --runInBand --no-cache`
    — cancellation propagation and graph projection coverage passed.
  - `yarn jest packages/core/tests/taskEngine.coverage.test.ts packages/core/tests/operator.runGraph.test.ts packages/core/tests/api.router.default.test.ts packages/driver-hatchet/tests/task.test.ts packages/driver-hatchet/tests/hatchetRuntimeDriver.test.ts --runInBand`
    — focused runtime/API/Hatchet suite passed: 94 tests. Expected console
    warnings/errors remain from tests that intentionally drive failed stores,
    trigger failures, cancellation, and timeout paths.
  - `yarn workspace @a2arium/callagent-core build` — core build passes.
  - `yarn workspace @a2arium/operator-viewer build` — viewer build passes. Vite
    still reports the known large bundle/chunk-size warning.
  - Manual root cancel check: canceling a live root run projects `canceled`
    instead of leaving stale running/waiting rows.
  - Manual child cancel check: canceling an in-flight child now causes the
    parent chain to converge to failed/canceled semantics instead of leaving
    parents waiting forever; child graph status is not overwritten by later
    completed segment rows.
  - Manual full real-flow restart check: start `discover-listing-selectors`, let
    it continue, kill `yarn runtime` mid-run, restart runtime, and verify the run
    resumes or fails coherently with no stale waiting/running operator state.
- `packages/core/tests/runtime/*` — runtime seam coverage for mapper, driver,
  wake applicator, segment executor, bootstrap, Scenario 0 parity, and driver
  routing.
- `apps/examples/phase2-parent-agent/tests/parentAgent.test.ts` — parent DAG
  regression coverage for loop-mode input normalization and completion after
  awaited child delegation.
- `packages/driver-hatchet/tests/task.test.ts` — durable parent task behavior,
  including `await_child` event waits, already-persisted child completion/failure
  recovery, out-of-order child completion selection, root finalization, semantic
  failure finalization, wait timeout failure, task logging, and Hatchet execution
  timeout defaults.
- `packages/core/tests/operator.runGraph.test.ts` — operator graph projection,
  durable turn fields, completed/failed child edge projection, recursive child
  turns, stale parent-row status derivation, stale running turn finalization, and
  semantic failure derivation.
- `yarn workspace @a2arium/operator-viewer build` — Vite/React viewer build
  passes. Vite still reports the known large bundle/chunk-size warning.
- `TaskEngine.sync`, `TaskEngine.inbox`, `TaskEngine.async_race` — pass with
  driver-routed call sites.
- All `packages/core/tests/TaskEngine*` suites — pass (151 tests).
- **D5:** full monorepo suite — 174 passed, 952+ tests, 64 skipped (2026-06-16).

## Phase 5 status

Phase 5A is implemented behind rollout flags:

- semantic tables exist for `agent_runs`, `agent_run_edges`, `turn_runs`,
  `run_effects`, and projection cursors;
- runtime `SessionManager.appendEvent` writes semantic task, child-edge, turn,
  memory, and budget facts when `CALLAGENT_OPERATOR_PROJECTION_WRITE` is
  `shadow` or `on`;
- bridge graph/list reads still repair semantic records as bounded backfill;
- semantic fleet reads derive child counts and turn metrics from edge/turn fact
  rows rather than provider list aggregates;
- semantic graph reads fall back to bridge if the semantic rows are incomplete;
- graph loading is topology-capped with collapsed-branch metadata instead of
  arbitrary array slicing;
- `CALLAGENT_OPERATOR_PROJECTION_READ=bridge|compare|semantic` keeps bridge as
  the default rollback path.

Phase 5B payload-budget surfacing is implemented for the primary runtime and
operator paths:

- shared payload budget helpers define envelopes, byte-budget readers,
  deterministic compaction, and semantic budget error payloads;
- `SessionManager.appendEvent` compacts oversized `wm_events` payloads while
  preserving operational fields (`taskId`, `turnSeq`, transition kind/result,
  child tokens) and emits `payload.budget_exceeded` facts;
- `SessionManager.saveSnapshot` records `wm.snapshot_limit` before throwing, so
  snapshot-limit failures are projected even when callers only retry/fail the
  segment;
- snapshot-limit, event payload, artifact-resolution, Hatchet payload, and
  operator-response budget failures are projected as visible `run_effects`;
- operator graph event payloads use explicit `PayloadEnvelope` states instead of
  inlining oversized raw JSON;
- Hatchet task/resume payloads and driver/log metadata are bounded or compacted,
  and oversized Hatchet task payloads record a semantic budget fact before the
  driver throws;
- graph detail responses enforce a final operator-response budget by omitting raw
  debug payloads and adding an `operator.response_budget` effect when needed;
- `JsonPreview` renders `available`, `too_large`, `artifact_only`, `hidden`, and
  `not_captured` envelope states.

Validation:

- `yarn jest packages/core/tests/operator.agentRunsList.test.ts packages/core/tests/operator.runGraph.test.ts packages/core/tests/taskEngine.coverage.test.ts --runInBand`
  — pass, including semantic read, runtime event projection, payload budget
  surfacing, snapshot-budget recording, operator-response budget capping,
  partial fallback, and graph cap coverage.
- `yarn jest packages/driver-hatchet/tests/hatchetRuntimeDriver.test.ts --runInBand`
  — pass, including semantic budget recording before oversized Hatchet task
  payload failures.
- `yarn workspace @a2arium/callagent-memory-sql build` — pass.
- `yarn workspace @a2arium/callagent-core build` — pass.
- `yarn workspace @a2arium/callagent-driver-hatchet build` — pass.
- `yarn workspace @a2arium/operator-viewer build` — pass.

Phase 5C observability scaffolding is implemented for the primary runtime and
operator paths:

- `packages/core/src/observability/metrics.ts` provides an in-process metrics
  registry with counters, gauges, durations, bounded samples, and derived warning
  alerts;
- the metrics registry now enforces production-safety cardinality limits:
  low-cardinality label allow-listing, bounded total/per-metric series, overflow
  buckets, dropped-series accounting, and endpoint-reported memory limits;
- `GET /metrics` exposes the current process metrics as JSON for operator/API
  smoke checks and can be disabled with `CALLAGENT_METRICS_ENABLED=false`;
- operator APIs record request counts, latency, status, and handled 5xx errors;
- Hatchet worker task wrappers record worker-task counts/durations and treat log
  sink failures as degraded observability, not task failure;
- Hatchet provider enqueue/cancel paths record enqueue/cancel metrics, and
  enqueue failures with task context append bounded `observability.incident`
  facts;
- `observability.incident` projects into `run_effects` and the operator graph as
  failed observability effects;
- timer reconciliation records due count, max lag, scan duration, failures, and
  timer-fire enqueue success/failure;
- working-memory event and snapshot sizes are exposed as metrics, and payload
  budget failures increment `payload.budget_failure_total`;
- outbox dispatch, retry, dead-letter, and inline fallback paths expose aggregate
  metrics without task/run labels;
- `phase5c-observability-drills.md` defines the drill evidence template and P3-P6
  observability drills, including the metric label/memory policy;
- controlled P6 log-sink degradation drill is recorded and passes, proving that
  Hatchet log sink failure does not mask successful task completion or the
  original task error.

Phase 5C is not yet a full production observability stack. Prometheus/OTel
exporters, paging integrations, and historical metrics persistence remain
follow-ups unless pulled into Phase 5D.

Phase 5D retention/security/deletion-gate scaffolding is implemented for the
operator harness:

- operator endpoints now share tenant normalization and shared-token production
  auth, with local development open by default;
- production non-public `/rpc` protects `tasks/send`, `tasks/sendSubscribe`, and
  `tasks/input`, with task-starting calls audited as payload launches;
- destructive/raw-payload operator actions write durable `operator_audit_events`;
- the operator launcher marks raw JSON runs as operator launches for audit;
- retention policy defaults preserve semantic summaries for 365 days, audit rows
  for 365 days, and debug/provider data for 7 days;
- `yarn operator:retention` provides dry-run by default and explicit
  `CALLAGENT_RETENTION_APPLY=true` apply mode with bounded batches;
- raw `wm_events` apply requires `CALLAGENT_RETENTION_PRUNE_WM_EVENTS=true`, and
  outbox rows are not pruned until pending/resolved state is represented;
- deletion-gate registry validation prevents marking legacy surfaces approved
  without parity, drill, rollback, metrics, retention, and approval evidence;
- `specs/phase5d-retention-security-deletion.md` records the operational
  contract.
- `production-readiness-evidence.md` records the first evidence pass: focused
  security/retention tests pass, a temp-table 100k query/index probe passes for
  current semantic index shapes, the local DB migration plus retention dry-run
  now pass, and a persisted 100k root-run semantic dataset has been benchmarked
  through operator HTTP endpoints. That persisted benchmark exposed and fixed a
  missing all-scope fleet recency index. A concurrent polling/browser-render
  pass is also recorded. The initial 20-poller pass showed 550-750 ms p95; the
  follow-up profile found redundant fleet aggregation reads and duplicate
  in-flight projection work. Fleet list now uses denormalized semantic counters,
  identical in-flight semantic reads are coalesced, and the local warm
  20-poller p95 is recorded at roughly 116-137 ms. P2 active real-agent evidence
  is now recorded: 20 active `fetch-page-router` roots delegated to `fetch-html`
  children, projected as `waiting` while children ran, avoided `unknown`, and
  completed with resolved semantic edges. Earlier 10-root and 3-root regression
  drills remain in the evidence ledger as historical sub-drills. P3 runtime
  kill/restart evidence is also recorded: 8 active roots were killed mid-run,
  the runtime restarted, and all roots/children/edges reached completed terminal
  state without stale `waiting`, `running`, or `unknown` projection. P3 Hatchet
  engine interruption evidence is recorded as well: the first drill exposed
  duplicate child delegation after durable parent re-entry, the driver now
  resumes persisted await boundaries and hydrates empty child wakes from child
  terminal events, and the passing rerun completed 8 roots with exactly one
  child edge per root. P3 NATS interruption evidence is also recorded: stopping
  and restarting the Compose `nats` service during 8 active roots still
  completed all roots/children/edges without duplicate children or stale
  waiting/running projection. P3 root cancellation evidence is recorded:
  canceling 8 waiting roots returns HTTP 200 for all requests, persists
  `task.canceled` events, preserves canceled roots against late non-terminal
  events, and settles the graph with canceled roots plus no active child state.
  P3 missing-child-wake evidence is recorded: suppressing provider child wake
  events for 8 waiting roots still completed all roots from persisted child
  terminal facts, with zero parent `task.child_completed` events and no duplicate
  child edges. P3 child-wait-timeout evidence is recorded: suppressing both the
  provider child wake and persisted child-terminal recovery for 8 waiting roots
  failed all roots with readable timeout-derived messages, persisted terminal
  driver-run error metadata for `complete ok:false`, and still settled child
  nodes and child edges to completed after child completion. P3 Postgres
  connection interruption evidence is recorded: terminating 20 active DB
  connections during 8 waiting parent/child runs still completed all roots,
  children, edges, and turns with no duplicate child edges and no stale active or
  unknown semantic state.

## Next action

Continue with Phase 5D/5E production readiness gates:

1. Validate Phase 5C automated tests and record at least one real failure drill
   using `phase5c-observability-drills.md`. Controlled P6 is recorded; live P5
   provider-enqueue evidence is still recommended before closing Phase 5C.
2. Decide whether Prometheus/OTel export belongs in Phase 5C follow-up or Phase
   5D deployment hardening.
3. Capture remaining operator API/UI proof that no stale waiting/running states
   remain after terminal outcomes, ideally with browser/DOM evidence once the
   browser automation dependency is restored.

## Open questions (carried from requirements §11)

- Outbox: replace vs consume vs coexist (ADR 0006 proposes consume-then-retire).
- Hot-resume latency budget (ADR 0004; POC gate B8).
- One global worker pool vs per-tenant (requirements A5: start global).
- Reconciling Hatchet run UI with `TurnTrace` (ADR 0006: link, don't duplicate).
- Cross-process bus choice/provisioning for Hatchet mode (ADR 0007: NATS
  required; in-memory bus only for in-process driver).
- Transactional outbox: today `enqueueOutbox` and `writeSnapshotCAS` are separate
  non-transactional calls (confirmed in code). Decide whether to couple them for
  migrated event types or rely on per-effect idempotency (ADR 0009).
- Live cutover: tasks already waiting in-process (pending tokens / `setTimeout`)
  when a deployment flips to Hatchet mode — one-time adoption story (beyond the
  timer reconciler).
- Parity harness: golden canonical-event traces proving in-process and Hatchet
  drivers are equivalent (ADR 0007 parity test needs a home/format).
