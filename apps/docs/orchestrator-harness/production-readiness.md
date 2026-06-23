# Production Readiness Plan

Last updated: 2026-06-23.

This is the promotion gate for running the Hatchet orchestration harness as a
production substrate, not a dashboard polish list. The runtime can plausibly run
10-20 active agent tasks in parallel once worker concurrency and external-service
limits are configured, but the current operator read path is not yet designed
for 100k historical runs without a dedicated read model, indexes, retention, and
load tests.

Production readiness is required before:

- the in-process fallback is deleted for any migrated surface;
- the operator viewer is used as the primary production incident UI;
- 100k-run retention is treated as a supported product requirement;
- Hatchet mode becomes the default driver for production tenants.

## Current Assessment

The core execution model is moving in the right direction: Hatchet owns durable
wait/spawn/sleep infrastructure while callAgent keeps the APLRET kernel,
snapshots, idempotency, and semantic operator graph. The remaining production
risk is mostly in read-side scale, payload discipline, operational controls, and
failure drills.

As of the 2026-06-23 harness sweep, the Phase 3 child wake/fan-in,
external-wake, cancellation, and operator-hardening slice is closed enough to
start Phase 4 timer work. That does not change the production gate: the system
still needs the read model, query validation, payload budgets, observability,
retention, and failure drills below before Hatchet mode or the operator viewer
can be treated as production defaults.

Known gaps from the current implementation:

- `GET /agent-runs` now uses child-link event facts for root/child
  classification instead of stale provider parent columns, but this is still a
  bridge read path. Production root/child scope should come from normalized
  persisted run/edge facts with indexes and retention semantics.
- `GET /tasks/:taskId/run-graph` recursively reads task sessions and events for
  the whole graph. This is fine for investigation, but needs caps and progressive
  loading for large fan-out trees.
- The operator viewer polls fleet and live detail APIs. Polling is acceptable for
  now, but it needs backoff, stale-tab behavior, and server-side query budgets
  before many users can watch many live runs.
- `driver_runs` is still carrying product-projection duties. It is useful bridge
  data, but production should persist normalized summary/graph records instead
  of rebuilding everything from provider rows and `wm_events`.
- Large payload and snapshot failures are real production risks. Artifacts must
  remain references until the exact consumer that needs content resolves them.
- Hatchet/log connectivity failures can create noisy retry loops. Logging must
  degrade without hiding the original segment error or flooding the worker.

## Readiness Workstreams

### 1. Scale-Oriented Read Model

Build a stable read model for fleet and graph views.

- Add normalized summary records for root/agent runs. At minimum, persist:
  `tenantId`, `taskId`, `rootTaskId`, `agentId`, `status`, `operation`,
  `createdAt`, `updatedAt`, terminal time, duration, parent id, child count,
  turn count, LLM counts, memory counts, known cost, output availability, and
  last semantic error.
- Stop deriving fleet root/child scope from a recent `wm_events` sample. Root vs
  child must come from persisted run/edge facts.
- Persist graph edges and turn summaries needed by the operator graph:
  parent-child edge token/kind/status, turn sequence/status/boundary, transition
  kind, output-produced marker, timing, and TurnTrace id.
- Add keyset pagination over indexed columns only. Avoid offset pagination and
  unbounded tenant scans.
- Add server-side caps for graph expansion. Large graphs should load the root and
  first visible branches first, then fetch collapsed branches on demand.

Minimum indexes to validate with `EXPLAIN ANALYZE`:

- fleet recency: `(tenantId, operation, createdAt, id)`;
- agent filter: `(tenantId, agentId, createdAt, id)`;
- status filter: `(tenantId, status, createdAt, id)`;
- root graph: `(tenantId, rootTaskId, operation, turnSeq)`;
- task lookup: `(tenantId, taskId)`;
- edge lookup: `(tenantId, parentTaskId)` and `(tenantId, childTaskId)`;
- event detail: `(tenantId, taskId, seq)` plus any selected event-type filter.

### 2. Runtime Safety and Backpressure

Production must make overload explicit and bounded.

- Derive Hatchet task timeouts from the agent runtime budget with a configured
  fallback and grace window.
- Configure concurrency limits at the right levels: global worker pool, tenant,
  agent, browser/tool pool, LLM provider, and per-task serialization.
- Classify retries: transient infrastructure errors retry with bounded backoff;
  semantic `fail` boundaries do not retry; poison rows or repeated segment
  failures move to a dead-letter state with enough context to investigate.
- Verify duplicate-safe side effects for tool calls, outbox dispatch, child
  spawning, timer firing, and external wakes.
- Define cancellation semantics for waiting tasks, queued child tasks, and
  currently running segments. Mid-segment preemption is not required, but the
  next durable boundary must honor cancellation.
- Add queue-age and wait-age limits so a task cannot remain "waiting" forever
  when the expected wake or child never arrives.

### 3. Payload, Artifact, and Snapshot Budgets

The production invariant: large content is referenced, not copied through every
event, snapshot, log, and API response.

- Enforce maximum sizes for snapshots, `wm_events`, driver metadata, Hatchet
  payloads, logs, and operator API responses.
- Store large HTML/text/model outputs as artifacts and keep event/snapshot data
  to artifact refs plus compact metadata.
- Resolve artifact content only at the consumer boundary that needs it, such as
  the LLM call or a deliberate operator download.
- When a budget is exceeded, persist a readable semantic error, such as snapshot
  too large, event too large, or payload omitted, with the offending field path
  where available.
- Sanitize previews in the operator API. The UI should distinguish "not
  captured", "hidden for safety", "available as artifact metadata", and
  "available only in transition/outbox data".
- Add tests for `LIMIT_WM_SNAPSHOT_TOO_LARGE` and equivalent payload-budget
  failures so they appear in the agent summary, turn summary, logs, and graph.

### 4. Observability and Incident Workflow

Operators need one semantic story across Hatchet, callAgent, logs, and traces.

- Ensure every run/log/event carries enough IDs to join data:
  `tenantId`, `taskId`, `rootTaskId`, `agentId`, `traceId`, token, provider run
  id, turn sequence, and segment id where available.
- Send worker logs to the same investigation surface the operator uses. Hatchet
  logs are useful, but the callAgent run graph must also show summarized segment
  exceptions and semantic failures.
- Add metrics and alerts for:
  queue depth, queue age, wait age, active workers, retries, dead letters,
  segment duration, segment timeout, child wait timeout, DB query latency,
  API p95/p99, event size, snapshot size, artifact size, and logging failures.
- Logging must degrade gracefully if Hatchet or the log sink is unavailable. A
  log-write failure must not hide or replace the original runtime failure.
- Add operator deep links: semantic run graph, Hatchet provider run, TurnTrace,
  artifact metadata, and LLM trace if present.

### 5. Operator UI Production Behavior

The dashboard must remain useful under load and safe around production data.

- Default fleet scope should be root runs only, with a clear switch to include
  child agents.
- Child counts must come from persisted edge facts, not from event archaeology.
- Live pages can poll for now, but must use adaptive intervals, pause in hidden
  tabs, and stop or slow polling after terminal status.
- The graph must render large trees progressively: collapsed branches, stable
  layout, turn nodes linked to the agent/child they caused, and no forced
  full-graph render when the graph is too large.
- Add explicit production environment handling. Default mode is development
  unless production is configured by the runtime; production pages should use a
  visible, unambiguous indicator and avoid accidental destructive actions.
- Add auth, tenant isolation tests, and read-only defaults before exposing
  production data.

### 6. Retention, Archival, and Data Hygiene

100k runs is a retention problem as much as a UI problem.

- Define retention periods for Hatchet provider data, `driver_runs`, semantic run
  summaries, `wm_events`, TurnTrace references, logs, and artifacts.
- Keep compact summaries longer than raw payloads/logs.
- Add archival or pruning jobs with metrics and dry-run mode.
- Ensure old runs still show a useful summary after raw logs/artifacts expire.
- Document which data is audit-grade and which data is operational/debug only.

## Production Test Gates

These gates must be automated or repeatable runbooks with recorded results.

### Gate P1 — Query and Index Review

- Seed enough data to represent at least 100k root runs, realistic child fan-out,
  and realistic event volume.
- Run `EXPLAIN ANALYZE` for fleet list, root-only list, include-children list,
  agent filter, status filter, and run graph load.
- No production fleet query may depend on unbounded tenant scans or bounded
  recent-event samples for correctness.

### Gate P2 — 100k-Run Operator Load Test

- 100k completed root runs are present.
- 20 roots are active concurrently, each with child agents and multiple turns.
- Fleet list p95 stays within the agreed product budget.
- Opening a representative run graph stays within the agreed product budget.
- Polling multiple live detail pages does not saturate Postgres, Hatchet, or the
  API host.

### Gate P3 — Worker and Orchestrator Failure Drills

- Worker killed mid-segment: one effective transition, duplicate wake no-op.
- Worker killed while waiting on child: parent resumes exactly once after child
  completion.
- Hatchet temporarily unavailable: API degrades clearly and logs do not storm.
- Postgres restart: worker/API recover and stuck runs are visible.
- NATS unavailable: stream degradation is visible without corrupting task state.

### Gate P4 — Timeout and Cancellation Drills

- Agent budget timeout is passed to Hatchet and enforced with grace.
- Missing child wake eventually becomes a terminal or actionable waiting state,
  not indefinite "waiting".
- Cancel while waiting, cancel with child, cancel after completion, and duplicate
  cancel are all idempotent.

### Gate P5 — Payload Budget Drills

- Large HTML flows through artifacts without being inlined into snapshots/events.
- Snapshot/event/log/API size limits fail with readable semantic errors.
- Operator summary shows the error code/message and payload availability state.
- LLM artifact resolution is tested separately from operator preview.

### Gate P6 — Rolling Upgrade and Cutover

- Rolling worker upgrade with active waits, timers, and child calls.
- Live cutover from in-process waits/timers to Hatchet mode with no lost wakes,
  no duplicate effects, and a rollback runbook.
- Cold-start recovery after all workers are stopped while tasks are waiting.

## Promotion Criteria

Production readiness is accepted when:

- the semantic read model, indexes, retention policy, and load test results are
  documented;
- production fleet/root filtering and child counts are correct without event
  sampling shortcuts;
- graph detail loads are capped and progressive for large trees;
- runtime timeout, retry, idempotency, cancellation, and dead-letter behavior are
  verified;
- payload/artifact budgets prevent snapshot/event/log/API bloat;
- logs, metrics, alerts, and deep links support real incident investigation;
- auth, tenant isolation, and production-mode UI behavior are in place;
- the parity harness and failure drills pass under both in-process and Hatchet
  drivers for the surfaces being migrated.
