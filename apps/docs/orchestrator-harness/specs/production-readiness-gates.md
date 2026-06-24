# Production Readiness Gates Spec

## Goal

Implement Phase 5 as a measurable production-readiness gate for the
Hatchet-backed runtime and Operator Dashboard.

Phase 5 must prove that the system can:

- serve operator fleet/detail views from a stable semantic read model;
- retain and query large run history without event archaeology;
- run 10-20 active agent tasks in parallel under configured backpressure;
- preserve correctness through restarts, cancellation, timeouts, and duplicate
  delivery;
- surface payload/artifact failures as readable semantic errors;
- support incident investigation through logs, metrics, alerts, and deep links;
- define deletion gates for in-process fallback paths.

This spec is the implementation contract for `production-readiness.md`. The
plan describes workstreams; this spec defines required data, APIs, tests, and
acceptance evidence.

## Non-Goals

- Do not make Hatchet provider rows the product read model.
- Do not delete in-process fallbacks until the deletion gates in this spec pass.
- Do not treat a working local demo as production readiness.
- Do not promise 100k-run retention or 10-20 parallel active roots without
  recorded capacity evidence.
- Do not introduce new agent-facing APIs unless a production gate cannot be met
  through the runtime/operator substrate.
- Do not solve general multi-tenant billing, RBAC policy design, or artifact
  governance beyond the operator/runtime requirements listed here.

## Terms

| Term | Meaning |
|---|---|
| semantic read model | callAgent-owned tables/records that represent product operator concepts, not provider debug rows |
| root run | top-level task started by a user/API/launcher |
| child run | A2A/sub-agent task spawned by another task |
| graph edge | durable parent/child relationship, including token and edge status |
| terminal fact | final status, terminal time, error/cancel summary, and output availability |
| capacity run | repeatable load test with recorded inputs, data volume, metrics, and result |
| failure drill | repeatable operational scenario such as worker kill, Hatchet outage, timeout, or cancellation |
| deletion gate | evidence required before an old in-process path can be removed |

## Source of Truth

callAgent semantic state is the source of truth for operator product behavior.

Hatchet remains infrastructure/debug state. `driver_runs` remains useful bridge
data for provider ids and debugging, but Phase 5 must stop depending on
`driver_runs` and bounded `wm_events` samples for fleet correctness, child
counts, terminal state, and graph topology.

Required ownership:

| Concern | Owner |
|---|---|
| run status, terminal error, cancel facts | callAgent semantic read model |
| parent/child edge facts | callAgent semantic read model |
| turn summaries and final transition facts | callAgent semantic read model |
| provider run ids and Hatchet deep links | `driver_runs` / provider bridge |
| raw cognition/event detail | snapshots, `wm_events`, TurnTrace, artifacts |
| durable scheduling/waiting | runtime driver + Hatchet |
| product fleet/detail APIs | semantic read model first, raw/debug fallback only by explicit drill-down |

## Semantic Read Model

Phase 5 must introduce normalized, indexed records for operator reads. Exact
table names may change, but the logical model must cover these shapes.

### `agent_runs`

```ts
type AgentRunRecord = {
  tenantId: string;
  taskId: string;
  rootTaskId: string;
  agentId: string;
  operation: 'agent.run';
  scope: 'root' | 'child';
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';
  attention?: 'stuck' | 'error' | 'warning';
  parentTaskId?: string;
  parentAgentId?: string;
  parentTurnSeq?: number;
  childCount: number;
  turnCount: number;
  llmCallCount: number;
  memoryOpCount: number;
  knownCostUsd?: string;
  startedAt?: string;
  updatedAt: string;
  terminalAt?: string;
  durationMs?: number;
  lastBoundaryKind?: string;
  waitingReason?: string;
  terminalCode?: string;
  terminalMessage?: string;
  cancelReason?: string;
  outputState: 'available' | 'not_captured' | 'hidden' | 'artifact_only' | 'transition_only';
  outputArtifactId?: string;
  traceId?: string;
  providerRunId?: string;
};
```

### `agent_run_edges`

```ts
type AgentRunEdgeRecord = {
  tenantId: string;
  rootTaskId: string;
  parentTaskId: string;
  childTaskId: string;
  parentTurnSeq?: number;
  token?: string;
  edgeKind: 'delegates_to' | 'await_child' | 'fanout';
  status: 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';
  createdAt: string;
  resolvedAt?: string;
  terminalCode?: string;
  terminalMessage?: string;
};
```

### `turn_runs`

```ts
type TurnRunRecord = {
  tenantId: string;
  taskId: string;
  rootTaskId: string;
  agentId: string;
  turnSeq: number;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  fromState?: string;
  toState?: string;
  transitionKind?: string;
  boundaryKind?: string;
  shieldOutcome?: string;
  executionKind?: string;
  outputProduced: boolean;
  llmCallCount: number;
  memoryOpCount: number;
  knownCostUsd?: string;
  terminalCode?: string;
  terminalMessage?: string;
  turnTraceId?: string;
};
```

### `run_effects`

```ts
type RunEffectRecord = {
  tenantId: string;
  rootTaskId: string;
  taskId: string;
  turnSeq?: number;
  operation:
    | 'child.spawn'
    | 'child.complete'
    | 'child.fail'
    | 'timer.schedule'
    | 'timer.fire'
    | 'tool.call'
    | 'outbox.dispatch'
    | 'memory.read'
    | 'memory.write'
    | 'llm.call';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'noop';
  idempotencyKey?: string;
  token?: string;
  providerRunId?: string;
  artifactId?: string;
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
```

The implementation may combine or split these records, but the API must be able
to answer every required query below from indexed semantic facts.

### Required Constraints

The physical schema must enforce the projection invariants. Minimum constraints:

```text
agent_runs:
  unique(tenantId, taskId)
  index(tenantId, rootTaskId)

agent_run_edges:
  unique(tenantId, parentTaskId, childTaskId, token)
  index(tenantId, rootTaskId, parentTaskId)
  index(tenantId, childTaskId)

turn_runs:
  unique(tenantId, taskId, turnSeq)
  index(tenantId, rootTaskId, taskId, turnSeq)

run_effects:
  unique(tenantId, idempotencyKey) where idempotencyKey is not null
  index(tenantId, rootTaskId, operation, updatedAt)
  index(tenantId, taskId, turnSeq, operation)
```

Counters such as `childCount`, `turnCount`, `llmCallCount`, and `memoryOpCount`
may be stored for fleet speed, but they must be derivable from edge/turn/effect
records and repairable by a reconciliation job. Stored counters are cached
summaries, not the only source of truth.

## Projection Rules

Projection must be idempotent and monotonic where possible.

Rules:

1. A terminal semantic fact wins over stale provider rows.
2. A newer running/waiting turn may keep a run active even if an older provider
   root row failed due to worker abort.
3. Canceled `agent.run` facts win over later completed segment rows for the same
   task, unless the task had already completed before cancel was accepted.
4. Child counts and root/child scope come from `agent_run_edges`, not recent
   event samples.
5. Terminal semantic failures must persist `code` and `message` in
   `agent_runs` and `turn_runs`.
6. Output availability is a state machine, not a boolean:
   `available`, `not_captured`, `hidden`, `artifact_only`, `transition_only`.
7. Projection updates must be safe to replay. Duplicate events/provider rows
   must not double-increment child/turn/effect counts.

## Projection Pipeline

Phase 5 must make projection mechanics explicit. The recommended rollout is a
dual-write plus repair model:

1. Runtime transition paths write semantic records synchronously when they
   already know a durable fact: task start, child edge creation, turn start,
   turn completion, terminal completion/failure/cancel, and output availability.
2. Provider/bridge observations (`driver_runs`, Hatchet ids, outbox/timer
   provider rows) enrich existing semantic records but do not determine product
   truth when a semantic fact exists.
3. An async projector/reconciler can backfill or repair records from snapshots,
   `wm_events`, `driver_runs`, and TurnTrace refs. It must be idempotent and may
   run repeatedly.
4. A projection cursor records the last processed source position for each
   source stream/table. Replaying from an earlier cursor must be safe.
5. Projection lag is observable. The operator may show a stale/projection-lag
   warning, but must not silently present incomplete semantic data as complete.

Required projection events/facts:

```text
task.started -> upsert agent_runs
task.status/running/waiting -> update agent_runs status/waitingReason
turn.started -> upsert turn_runs(status=running)
turn.completed -> upsert turn_runs + update agent_runs counters/status
child.spawned/await_child -> upsert agent_run_edges + child agent_runs scope=child
child.completed/failed/canceled -> update edge + parent/child summaries
task.completed/failed/canceled -> terminal agent_runs fact
timer/tool/outbox/memory/llm effect -> upsert run_effects
budget/payload/log failure -> terminal or warning fact on run/turn/effect
```

Projection conflicts must be resolved deterministically. If two records disagree,
prefer in order:

1. terminal semantic task fact;
2. explicit cancel fact accepted before terminal completion;
3. newest turn semantic fact by `turnSeq` and timestamp;
4. provider/debug row only when no semantic fact exists.

## Migration and Backfill

Phase 5 implementation must be staged behind read/write flags:

```text
CALLAGENT_OPERATOR_PROJECTION_WRITE=off|shadow|on
CALLAGENT_OPERATOR_PROJECTION_READ=bridge|compare|semantic
```

Required migration sequence:

1. Create semantic tables and indexes without changing reads.
2. Enable `shadow` projection writes for new runs.
3. Backfill a bounded recent window from existing snapshots, `wm_events`,
   `driver_runs`, and TurnTrace refs.
4. Add a compare endpoint or test harness that reads the same runs through the
   old bridge projection and the new semantic model, then reports mismatches.
5. Fix mismatches or document intentional differences.
6. Switch fleet/detail reads to `compare` in development and staging.
7. Switch reads to `semantic` only after query plans and correctness checks pass.
8. Keep the bridge read path available as a rollback until deletion gates pass.

Backfill must be resumable. It must record progress, data window, source counts,
success counts, mismatch counts, and skipped/unsupported historical cases.

## API Contracts

The existing operator APIs may keep their URLs, but their production path must
read from the semantic model.

### Fleet List

```text
GET /agent-runs
```

Required query parameters:

- `tenantId`
- `agentId`
- `status`
- `since`
- `taskId`
- `hasLlm`
- `hasMemory`
- `costState`
- `includeChildren` (default `false`)
- cursor/page size

Required behavior:

- root-only is default;
- include-children switch is explicit and correct;
- child counts are correct for every row;
- filters use indexed columns;
- no offset pagination;
- no bounded recent-event sampling for correctness;
- terminal rows do not flip back to running/waiting because stale provider rows
  arrive later.

Minimum response shape:

```ts
type AgentRunsResponse = {
  items: Array<{
    tenantId: string;
    taskId: string;
    rootTaskId: string;
    agentId: string;
    scope: 'root' | 'child';
    status: AgentRunRecord['status'];
    attention?: AgentRunRecord['attention'];
    childCount: number;
    turnCount: number;
    llmCallCount: number;
    memoryOpCount: number;
    knownCostUsd?: string;
    updatedAt: string;
    terminalAt?: string;
    durationMs?: number;
    terminalCode?: string;
    terminalMessage?: string;
    outputState: AgentRunRecord['outputState'];
  }>;
  pageInfo: {
    nextCursor?: string;
    hasMore: boolean;
    limit: number;
  };
  projection: {
    source: 'bridge' | 'semantic';
    lagMs?: number;
    partial: boolean;
  };
};
```

### Run Graph

```text
GET /tasks/:taskId/run-graph
```

Required behavior:

- root graph loads from semantic run/edge/turn/effect facts;
- large graphs return a capped first response with collapsed branches;
- branch expansion uses explicit cursor/branch parameters;
- graph node status includes semantic terminal code/message where relevant;
- turn nodes link to child agents through `agent_run_edges.parentTurnSeq`;
- debug provider ids are present as links, not as product vocabulary.

Minimum response additions:

```ts
type RunGraphResponse = {
  rootTaskId: string;
  nodes: unknown[];
  edges: unknown[];
  collapsedBranches?: Array<{
    parentTaskId: string;
    hiddenChildCount: number;
    expandCursor: string;
    reason: 'node_limit' | 'depth_limit' | 'manual';
  }>;
  caps: {
    nodeLimit: number;
    edgeLimit: number;
    depthLimit: number;
    truncated: boolean;
  };
  projection: {
    source: 'bridge' | 'semantic';
    lagMs?: number;
    partial: boolean;
  };
};
```

### Drill-Down Detail

```text
GET /tasks/:taskId/turns/:turnSeq
GET /tasks/:taskId/memory
GET /tasks/:taskId/effects
```

Required behavior:

- summary rows are semantic and compact;
- raw JSON/payloads are opt-in;
- oversized or unsafe payloads return explicit availability states;
- copy/debug actions never require the fleet/detail API to inline huge content.

Raw payload endpoints must return an explicit availability envelope:

```ts
type PayloadEnvelope =
  | { state: 'available'; contentType: string; value: unknown; truncated: boolean }
  | { state: 'artifact_only'; artifactId: string; summary?: string }
  | { state: 'hidden'; reason: string }
  | { state: 'not_captured'; reason?: string }
  | { state: 'too_large'; limitBytes: number; actualBytes?: number; summary?: string };
```

## Index and Query Requirements

Minimum indexes to validate with `EXPLAIN ANALYZE`:

```text
agent_runs(tenantId, scope, updatedAt, taskId)
agent_runs(tenantId, agentId, updatedAt, taskId)
agent_runs(tenantId, status, updatedAt, taskId)
agent_runs(tenantId, taskId)
agent_runs(tenantId, rootTaskId)
agent_run_edges(tenantId, rootTaskId, parentTaskId)
agent_run_edges(tenantId, childTaskId)
turn_runs(tenantId, taskId, turnSeq)
turn_runs(tenantId, rootTaskId, taskId, turnSeq)
run_effects(tenantId, taskId, turnSeq, operation)
run_effects(tenantId, rootTaskId, operation, updatedAt)
```

Required query paths:

1. Fleet root-only recency.
2. Fleet include-children recency.
3. Fleet by agent id + status.
4. Fleet by task id prefix/exact lookup.
5. Run graph first page for a root with many children.
6. Expand one collapsed child branch.
7. Turn detail by task/turn.
8. Memory/effect summary by task.

No production query may require scanning all rows for a tenant, loading all
events for a graph, or reading raw payloads to compute row status.

Initial performance budgets, subject to revision after the first capacity run:

| Query/API | Target |
|---|---|
| fleet first page, 50 rows, root-only | p95 <= 300 ms, p99 <= 750 ms |
| fleet filtered by agent/status | p95 <= 500 ms, p99 <= 1 s |
| exact task lookup | p95 <= 150 ms |
| run graph first capped page | p95 <= 1 s, p99 <= 2.5 s |
| expand one collapsed branch | p95 <= 750 ms |
| turn detail | p95 <= 300 ms |

Initial graph caps:

```text
first response: <= 250 nodes, <= 350 edges, depth <= 4
branch expansion: <= 150 nodes, <= 250 edges
raw payload per operator response: <= 1 MiB unless explicitly downloaded
```

If these budgets prove unrealistic, the implementation must update this spec
with measured evidence and a new target before declaring Phase 5 complete.

## Payload and Artifact Budgets

Phase 5 must define hard budgets and semantic failure states.

Required budget classes:

| Class | Required handling |
|---|---|
| snapshot | reject/omit oversized fields before DB write corrupts the task |
| `wm_events` payload | store compact refs and summary only |
| Hatchet payload | ids and compact metadata only |
| `driver_runs` metadata | debug ids and status only; no large HTML/text |
| logs | bounded message + refs; large stack/payload truncation with count |
| operator API response | capped summaries; raw payload opt-in |
| LLM input | may resolve artifacts at the LLM boundary, with provider-specific chunking/error handling |

Readable error codes must include:

```text
LIMIT_WM_SNAPSHOT_TOO_LARGE
LIMIT_EVENT_PAYLOAD_TOO_LARGE
LIMIT_DRIVER_METADATA_TOO_LARGE
LIMIT_HATCHET_PAYLOAD_TOO_LARGE
LIMIT_OPERATOR_RESPONSE_TOO_LARGE
ARTIFACT_RESOLUTION_FAILED
```

Every budget failure must appear in:

- agent summary;
- turn summary when turn-related;
- graph node status/attention;
- logs/effects;
- raw debug detail.

## Runtime Safety and Backpressure

Production runtime must be bounded by configuration, not accidental defaults.

Required controls:

- Hatchet task timeout derived from agent budget, with configured fallback and
  grace window;
- worker concurrency limit;
- tenant concurrency limit;
- agent concurrency limit;
- browser/tool pool limit;
- LLM provider concurrency/rate limit;
- per-task serialization key;
- queue age and wait age thresholds;
- retry backoff and max attempts by error class;
- DLQ/dead-letter behavior for poison rows or repeated segment failures.

Retry classification:

| Error type | Behavior |
|---|---|
| transient infrastructure error | retry with bounded backoff |
| semantic `fail` boundary | terminal, no retry |
| duplicate wake/effect | success no-op |
| canceled task/timer | success no-op or terminal canceled |
| payload budget violation | terminal semantic failure unless a safe truncation/ref path exists |
| log sink failure | record degraded logging, do not replace original error |

## Observability Contract

Every operator-visible run and worker log must be joinable by ids:

```text
tenantId
rootTaskId
taskId
agentId
turnSeq
token
traceId
providerRunId
providerTaskRunId
segmentId
idempotencyKey
```

Required metrics:

- fleet API p50/p95/p99 latency;
- run graph API p50/p95/p99 latency;
- query row counts and query duration for critical paths;
- active workers;
- active roots/children/segments;
- queue depth and queue age;
- wait age by boundary kind;
- timer lag;
- retry count by operation/error class;
- DLQ/dead-letter count;
- segment duration and timeout count;
- child wait timeout count;
- snapshot/event/log/artifact sizes;
- log sink failures;
- Hatchet enqueue failures;
- NATS stream delivery failures.

Required alerts:

- stuck waiting beyond threshold;
- stuck running beyond budget/grace;
- timer lag beyond threshold;
- queue age beyond threshold;
- DLQ/dead-letter nonzero for critical operations;
- API p95/p99 above budget;
- log sink failure rate above threshold;
- DB query latency above threshold;
- provider enqueue failures above threshold.

## Operator UI Requirements

Phase 5 UI work is production behavior, not visual polish.

Required behavior:

- default fleet scope is root runs only;
- include-children switch works and is persisted locally;
- child counts are accurate;
- live polling uses adaptive intervals and hidden-tab pause;
- terminal runs slow/stop polling;
- graph auto-fit handles newly added nodes without losing selected state;
- graph caps large trees and supports branch expansion;
- cancel controls are visible but not visually dominant;
- production environment indicator comes from runtime configuration only;
- destructive actions require appropriate production confirmation;
- all missing/hidden/unsafe data states are explicit.

## Retention and Archival

Phase 5 must define retention classes before claiming 100k-run support.

Required retention policy:

| Data | Required decision |
|---|---|
| semantic run summaries | longest-lived operational record |
| graph edges/turn summaries | retained with semantic run summaries |
| provider `driver_runs` | shorter debug retention acceptable |
| Hatchet provider data | follow self-hosted retention/backup plan |
| `wm_events` raw details | bounded retention; summaries outlive raw |
| TurnTrace refs | retain refs even when raw trace expires |
| logs | retention by severity and incident/audit need |
| artifacts | explicit TTL/storage policy and redaction story |

Old runs must remain intelligible after raw/debug data expires: status,
duration, agent id, child count, turn count, terminal code/message, and output
availability must still be visible.

## Security and Tenant Isolation

Minimum production gate:

- tenant id is server-authoritative;
- every semantic read query is tenant scoped;
- operator auth is required outside local development;
- destructive actions require operator authorization;
- raw JSON/artifact access is separately permissioned or explicitly scoped;
- payload previews are sanitized;
- secrets are not logged or copied into operator summaries;
- tests cover cross-tenant read denial for fleet, graph, turn, memory, effect,
  artifact, and cancel endpoints.

Destructive/operator actions must write audit records. Minimum audit fields:

```ts
type OperatorAuditRecord = {
  tenantId: string;
  action: 'run.cancel' | 'agent.cancel' | 'retry' | 'resume' | 'delete' | 'payload.view';
  actorId: string;
  actorType: 'user' | 'service' | 'dev-local';
  rootTaskId?: string;
  taskId?: string;
  agentId?: string;
  reason?: string;
  requestedAt: string;
  accepted: boolean;
  resultStatus?: string;
  errorCode?: string;
  childPropagation?: 'none' | 'best_effort' | 'completed';
};
```

Audit records are semantic operational records, not UI logs. They must survive
operator page reloads and be tenant scoped.

## Phase 5 Rollout Slices

Phase 5 should be implemented in slices. A slice may ship before the whole phase
is complete if it is behind flags and does not delete fallback behavior.

### Phase 5A — Semantic Read Model and API Migration

Scope:

- create semantic tables and constraints;
- write projection pipeline in `shadow` mode;
- backfill recent runs;
- add bridge-vs-semantic compare harness;
- switch fleet/detail APIs to semantic reads behind
  `CALLAGENT_OPERATOR_PROJECTION_READ`.

Exit:

- fleet root/child scope and child counts come from edge facts;
- stale provider rows no longer flip terminal/active state incorrectly;
- query budgets pass on seeded data for fleet and representative graph detail.

### Phase 5B — Payload Budgets and Semantic Error Surfacing

Scope:

- define hard size limits;
- keep large content as artifact refs;
- add semantic budget errors to run/turn/effect summaries;
- update operator JSON/raw payload envelopes.

Exit:

- `LIMIT_WM_SNAPSHOT_TOO_LARGE` and equivalent budget errors are readable in
  summary, turn, graph, and raw detail;
- LLM artifact resolution is tested separately from operator preview.

### Phase 5C — Observability and Failure Drills

Scope:

- metrics and alerts, initially via the internal JSON `/metrics` endpoint;
- log-sink degradation behavior;
- retry/DLQ visibility;
- recorded P3/P4/P5 drills.

Exit:

- incident paths have metrics, logs, semantic summaries, and deep links;
- metrics are memory-bounded and do not use task/run identifiers as labels;
- failure drills produce recorded evidence.

Prometheus/OpenTelemetry exporters are acceptable follow-ups as long as the
internal metrics contract exists first and every listed drill has machine-readable
signals.

### Phase 5D — Retention, Security, and Deletion Gates

Scope:

- retention/pruning jobs;
- audit records for destructive actions;
- tenant isolation tests;
- parity harness for deletion candidates;
- per-surface deletion approvals.

Exit:

- old runs remain intelligible after raw/debug expiry;
- destructive actions are audited;
- deletion candidates are explicitly approved or left behind flags.

## Tests

Required automated coverage:

1. Projection idempotency: replaying the same event/provider row does not change
   counts or terminal facts.
2. Terminal precedence: stale provider failures do not override newer active
   segments; canceled agent rows are not overwritten by later segment completion.
3. Root/child fleet scope comes from edge facts.
4. Child counts are correct for completed, failed, canceled, and waiting edges.
5. Turn summaries preserve transition kind, output marker, terminal code/message,
   and TurnTrace refs.
6. Large payload budget failures appear in agent summary, turn summary, graph,
   and raw debug detail.
7. Operator APIs paginate by keyset and reject/limit oversized graph reads.
8. Tenant isolation for every operator endpoint.
9. Runtime timeout mapping passes budget/fallback/grace to Hatchet tasks.
10. Retry classification tests for transient, semantic, duplicate, canceled,
    payload-budget, and log-sink failure classes.
11. Live polling slows/stops on terminal state and pauses in hidden tabs.
12. Retention/pruning dry-run preserves semantic summaries.
13. Bridge-vs-semantic compare harness reports mismatches for fleet rows, graph
    topology, terminal facts, and turn summaries.
14. Projection backfill is resumable and idempotent.
15. Operator audit records are written for cancel/destructive/raw-payload
    actions and are tenant scoped.

## Manual Drills

Each drill must record date, commit, config, data volume, commands, expected
result, actual result, and follow-up bugs.

### P1 — Query and Index Review

```text
seed >= 100k completed root runs
seed realistic child fan-out and turn/effect volume
run EXPLAIN ANALYZE for required query paths
record p50/p95/p99 and query plans
```

Acceptance:

- no unbounded tenant scans;
- no event archaeology for fleet correctness;
- no offset pagination;
- p95/p99 within the initial budgets in this spec, or the spec is updated with
  measured evidence and new accepted budgets.

### P2 — 20 Active Roots

```text
start 20 active root runs with realistic child agents
watch fleet and several detail pages
record API, DB, worker, Hatchet, NATS, and browser behavior
```

Acceptance:

- no stale waiting/running status after terminal events;
- polling does not saturate API/DB;
- graph remains responsive through progressive loading/caps.

### P3 — Restart and Outage Drills

```text
kill worker mid-segment
kill worker while parent waits on child
restart runtime after due timers pass
restart Postgres
temporarily stop Hatchet
temporarily stop NATS
```

Acceptance:

- task state is coherent;
- duplicate wakes/effects are no-ops;
- failures are visible and semantic;
- logs/metrics identify the degraded dependency.

### P4 — Timeout and Cancellation Drills

```text
run task that exceeds agent budget
run parent waiting on missing child
cancel root while waiting
cancel child while parent waits
cancel completed task
repeat cancel
```

Acceptance:

- timeout reason is readable;
- missing child does not wait forever;
- cancellation is idempotent;
- parent/child graph converges.

### P5 — Payload Budget Drills

```text
run large HTML/artifact flow
force snapshot-too-large
force event/log/operator-response budget failures
run LLM boundary that resolves artifact content
```

Acceptance:

- large content stays referenced until consumer boundary;
- budget failures are semantic and visible;
- operator preview does not inline unsafe/huge payloads;
- LLM artifact resolution behavior is tested separately.

### P6 — Rolling Upgrade and Cutover

```text
run active waits, timers, child calls, and running segments
roll worker version
flip a deployment from in-process waits/timers to Hatchet mode
rollback
```

Acceptance:

- no lost wakes/timers;
- no duplicate effects;
- rollback is documented and works.

## Acceptance Criteria

Phase 5 is done when:

1. Semantic run/edge/turn/effect records exist and back fleet/detail APIs.
2. Fleet root/child scope, child counts, terminal errors, cancel facts, and
   output states no longer depend on bounded event samples.
3. Projection migration has run through `shadow` and `compare`, with recorded
   mismatch results and explicit decisions for intentional differences.
4. Required query paths have recorded `EXPLAIN ANALYZE` evidence against the
   agreed data volume and meet the active budgets in this spec.
5. Graph loading is capped/progressive for large trees.
6. Payload/artifact budgets produce readable semantic failures and preserve refs.
7. Runtime timeouts, retries, concurrency, cancellation, DLQ behavior, and
   duplicate-safe effects are configured and tested.
8. Logs, metrics, alerts, and deep links support incident investigation.
9. Operator UI production behaviors are implemented and tested.
10. Retention/pruning policy is implemented or documented with explicit blockers.
11. Security, tenant-isolation, and operator-audit tests pass.
12. Manual drills P1-P6 have recorded results.
13. Deletion gates list exactly which in-process paths may be removed and which
    remain guarded by fallback flags.

## Deletion Gate

No in-process path may be deleted until:

- semantic read model is the production read path for that surface;
- parity tests pass for both in-process and Hatchet drivers;
- failure drills pass for that surface;
- rollback path is documented and tested;
- production metrics/alerts cover that surface;
- migration flag can restore the previous behavior without agent-code changes;
- data retention behavior is documented for records produced by both paths.

Deletion approval must be per surface, not global. A passing timer gate does not
authorize deleting child-completion fallback code; a passing child gate does not
authorize deleting in-process token-expiry waits.
