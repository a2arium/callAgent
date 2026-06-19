# Implementation Plan

Staged plan to adopt the orchestrator substrate without refactoring the APLRET
kernel. Each phase is independently shippable and reversible.

## Phase 0 — Kernel seam (no orchestrator)

Goal: make the loop driver pluggable without changing behavior.

1. Define `TurnExecutor` port: `runSegment({ tenantId, taskId, wake,
   idempotencyKey }) → SegmentResult` (boundary = await/sleep/terminal). Back it
   by the existing `TaskExecutor.executeTurn` / `runLoop`
   (`packages/core/src/orchestration/TaskExecutor.ts`). Internal `continue` turns
   stay inside the segment (ADR 0002).
2. Define `RuntimeDriver` port + `InProcessRuntimeDriver` that reproduces today's
   `TaskEngine` scheduling exactly (immediate resume, `setTimeout` waits, outbox
   poll).
3. Inject the driver at the composition root (`TaskEngine` constructor;
   `apps/examples/runtime-host/src/server.ts`). Default = in-process. Extract the
   shared bootstrap (agents/tools/plugins/memory/LLM/bus) into one function so a
   future worker reuses it (`specs/worker-runtime.md`).
4. Acceptance: full test suite passes unchanged (D5); no orchestrator types
   anywhere (D1); `packages/core` public surface unchanged.

Deletes: nothing. This phase only adds seams.

## Hatchet docs (Phases 1–5)

Before any Hatchet adapter, task definition, SDK call, or ops procedure: consult
the vendored docs at `apps/docs/external/hatchet-docs/` (`@hatchet-docs` in
Cursor) for the relevant page(s). ADRs and specs capture decisions and caveats,
but SDK/API details, guarantees, and edge cases must be verified against the
source docs — do not implement from ADR summaries alone.

Phase-to-page mapping (read the pages that match the work):

| Phase | Primary hatchet-docs pages |
|---|---|
| 1 — outbox | workers, tasks, retries, self-hosting dashboard |
| 2 — durable loop | `durable-execution`, `durable-tasks`, `child-spawning`, `concurrency` |
| 3 — event wakes | `durable-event-waits`, events API |
| 4 — timers | `durable-sleep`, `scheduled-runs` (missed-schedule caveat, ADR 0003) |
| 5 — production | self-hosting HA/upgrade/retention, Prometheus metrics |

See also the key-page list in `README.md` § Hatchet docs reference.

## Phase 1 — Hatchet outbox dispatch

Goal: lowest cognition risk, highest ops value. Prove the Hatchet integration,
metadata search, and `driver_runs` mapping.

1. New workspace `packages/driver-hatchet` (no upward imports).
2. `aplret.outbox.dispatch` task: claim outbox row → publish existing event →
   mark delivered. Hatchet **consumes** the outbox table; the in-process poll
   loop is the fallback (ADR 0006).
3. Add `driver_runs` mapping + composite metadata keys (`tenantTaskKey`,
   `tenantTraceKey`, `taskTokenKey`).
4. Acceptance: POC gates B5, B6, B7 (search, replay/cancel, self-hosted UI).

Known limitation (resolved in Phase 2): each `aplret.outbox.dispatch` is an
independent top-level Hatchet run triggered externally from the runtime host
(`runNoWait`). Hatchet only groups runs in the dashboard when they are spawned as
children from within a parent task (`ctx.runChild` / `ctx.runNoWaitChild` /
`ctx.bulkRunChildren`); shared metadata enables search/filter but does **not**
nest runs. As a result a busy task emits many sibling dispatch runs (one per
outbox row, e.g. several `task.status` plus `task.input_required`). This is
acceptable for the Phase 1 POC (search by `tenantTaskKey` works) but is not an
acceptable steady-state operator UI. Phase 2 makes the per-task Hatchet run the
parent so these become grouped children.

Deletes (guarded by flag): `OutboxPublisher` poll loop for migrated event types.

## Phase 2 — Hatchet durable task for the APLRET loop

Goal: the native Model B core. A Hatchet durable task owns one APLRET task's
lifecycle.

Prerequisites (must land before/with this phase):

- **Durable dedupe** (ADR 0005): `processedKeys` in snapshot or `processed_wakes`
  table, committed atomically with the snapshot. The in-memory RPC store is not
  sufficient.
- **Per-effect idempotency + retry policy** (ADR 0009): deterministic keys for
  tool/outbox/child/timer effects; `throw` = transient retry (bounded), `fail`
  boundary = terminal (never retried). This is the correctness prerequisite —
  wake dedupe alone does not protect partial/crashed segments.
- **Cross-process bus** (ADR 0007): NATS wired so worker-produced stream events
  reach the API host's SSE/chat.
- **Worker bootstrap** (`specs/worker-runtime.md`): worker builds the full
  composition root and initializes `EngineLocator` for its own process.

1. `aplret.segment` child task = `TurnExecutor.runSegment` (non-deterministic;
   runs `runLoop` to the next durable boundary).
2. `aplret.task` durable task loop: spawn `aplret.segment` → branch on
   `boundary` → `waitForEvent` / `sleepFor` / spawn child → repeat; return on
   terminal. No `continue` case crosses the boundary.
3. Per-task serialization via concurrency key `tenantId:taskId`, limit 1.
4. **Operator run graph (required):** `aplret.task` or `agent.<agentId>` is the
   single parent Hatchet run per callAgent task. All per-task work —
   `aplret.segment`, `aplret.outbox.dispatch`, child dispatch — must be spawned as
   children of that parent (`ctx.runChild` / `ctx.runNoWaitChild` /
   `ctx.bulkRunChildren` / durable `spawnChild`) so the dashboard nests them under
   one run rather than flooding the top-level run list with sibling dispatch runs
   (the Phase 1 limitation). This Hatchet grouping is only the infrastructure
   view. The product/operator view is the callAgent `AgentRunGraph`, where the
   root agent, child agent calls, turns, effects, logs/events, input/output
   previews, TurnTrace refs, and raw provider ids are returned by
   `GET /tasks/:taskId/run-graph`.
   Outbox dispatch triggered for a task while its durable parent run is active
   must route through the parent, not an external top-level `runNoWait`.
   External-only fallback dispatch — e.g. before the durable loop exists or when
   no active parent run is found — may stay top-level and must still be projected
   as debug `EffectRun` data.
5. Acceptance: POC gates B1 (crash mid-segment), B3 (duplicate resume no-op via
   durable dedupe), B4 (serialization), B8 (latency: hot resume stays in-process
   and internal `continue` turns do not round-trip), plus ADR 0007 streaming
   parity (identical SSE under both drivers), plus **operator graph acceptance:**
   one callAgent task renders as one root `AgentRun`; child calls render as
   `AgentRunEdge` + child `AgentRun` nodes; turns link to TurnTrace; effects are
   hidden by default; logs/events are grouped by task/agent/trace/span/token; raw
   Hatchet workflow names and run ids are available only as debug details; and
   filtering by `tenantTaskKey` / `agentId` / `traceId` / token still works.
   The durable end state should persist normalized graph facts (`agent_runs`,
   `agent_run_edges`, `turn_runs`, `effect_runs`) rather than relying on JSON
   archaeology from `wm_events` and snapshots.

Deletes (guarded): `resumeInput` auto-turn scheduling, `handleToolCompleted` /
`handleExternalEventOccurred` auto-resume, child-completion CAS/resume retry
loops, `childCompletionInFlight`, `LoopRegistry` active-loop injection,
`runTaskSessionExclusive` (in Hatchet mode).

## Phase 3 — External wakes as events

Goal: remove resume coordination entirely in Hatchet mode.

1. `tasks/input` (non-hot), tool/webhook callbacks, A2A child completion, and
   conversation-delivered wakes (ADR 0008) →
   `hatchet.events.push('aplret.<kind>.<token>', …)` via `enqueueResume`.
2. Durable event waits in `aplret.task` resume on the matching event. Event keys
   come only from tokens minted by a prior segment (ADR 0002 token provenance).
3. Hot chat/SSE resumes stay in-process (ADR 0004).
4. Cancellation: implement boundary cancellation (ADR 0010) — intent in snapshot,
   pending-token wakes become no-ops, queued Hatchet runs cancelled best-effort.
5. Acceptance: POC gate B9 (fan-out/fan-in), parity of projected stream events,
   plus cancel-while-waiting / cancel-with-children scenarios (ADR 0010).

Deletes (guarded): `A2AService` `queueMicrotask` deferral; TurnRunner event-log
backfill (`243–309`) where Hatchet guarantees ordering.

## Phase 4 — Timers via durable sleep + reconciler

Goal: native, restart-safe timers.

1. Token expiry / "sleep until" via `ctx.sleepFor` inside `aplret.task`.
2. `TimerReconciler`: scan pending tokens with `expiresAt <= now`, enqueue
   `aplret.timer.fire` idempotently on startup + periodically (defense in depth).
3. Acceptance: POC gate B2 (timer survives engine/worker restart; downtime
   covered by reconciler).

Deletes (guarded): in-process `setTimeout` semantic waits for token expiry.

## Phase 5 — Production gates

1. B10 upgrade drill with active timers/runs; rollback runbook.
2. B11 100k-run volume test (Postgres size, dashboard speed, retention).
3. C2 cost model; C3 HA / RPO-RTO per state type; C4 alerts.
4. **Live cutover drill:** flip a deployment with tasks already waiting
   in-process (pending tokens / `setTimeout`) to Hatchet mode; verify no lost
   wakes/timers and no duplicate effects (reconciler + dedupe).
5. Decide which deletion targets are permanent and remove the dead in-process
   code for fully-migrated surfaces.

## Cross-cutting: parity harness

Before deleting any in-process path, stand up a parity harness that runs the same
scenarios under both drivers and asserts identical canonical event traces
(ordering, visibility, finality) — the streaming-harness golden-fixture approach
applied to the driver seam. This is the executable form of the ADR 0007 parity
test and the safety net for the deletion inventory.

## Reversibility

Every phase is behind `config.driver` (`in-process` | `hatchet`) and per-surface
flags. Flipping back to in-process must require zero agent code changes (R-M2).
