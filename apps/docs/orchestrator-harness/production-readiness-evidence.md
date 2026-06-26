# Production Readiness Evidence

Status: active evidence ledger.
Last updated: 2026-06-26.

This file records repeatable evidence for
`specs/production-readiness-gates.md` and `production-readiness.md`. It is not a
replacement for the readiness plan; it is the dated proof trail for gates that
were actually run.

## Guidance on 100k Testing

Do not run 100k real agent executions as the default readiness test. That mostly
tests external provider cost, Hatchet queue churn, and fixture noise. The useful
production signal is split:

- seed or synthesize at least 100k historical semantic run rows and validate
  fleet/graph/read-side queries with `EXPLAIN ANALYZE`;
- separately run a real active-concurrency drill with 10-20 parallel agent tasks,
  children, cancellation, restart, timeout, and missing-wake scenarios.

100k real executions may be useful later as a soak test, but it should not be
the first or normal gate.

## 2026-06-24 — Phase 5D Security/Retention Automated Checks

Commit:

- `f892d28` (`Harden operator production readiness gates`) plus the follow-up
  working-tree retention dry-run fix recorded below.

Command:

```bash
yarn jest packages/core/tests/api.router.default.test.ts \
  packages/core/tests/operator.retention.test.ts \
  packages/core/tests/operator.deletionGates.test.ts \
  --runInBand
```

Result:

- passed;
- 3 test suites;
- 23 tests.

Covered:

- production operator auth fails closed without a configured token;
- configured production token is required;
- production non-public `/rpc` protects `tasks/send`, `tasks/sendSubscribe`,
  and `tasks/input`;
- server-pinned operator tenant is propagated into protected task-start/input
  calls;
- `CALLAGENT_RPC_PUBLIC=true` is the explicit public-RPC escape hatch;
- cancel and raw-payload launch audit records are written;
- retention dry-run preserves semantic summaries;
- retention apply requires explicit environment confirmation;
- raw `wm_events` pruning remains blocked unless explicitly enabled;
- deletion gates reject approved/deleted legacy surfaces without required
  evidence.

## 2026-06-24 — Local Database Migration Probe

Goal:

- verify whether the local operator database is ready for real retention dry-run
  and production-readiness SQL checks.

Command shape:

```bash
psql "$MEMORY_DATABASE_URL" -c "
select tablename
from pg_tables
where schemaname='public'
  and tablename in (
    'agent_runs',
    'turn_runs',
    'agent_run_edges',
    'run_effects',
    'operator_audit_events',
    'driver_runs',
    'runtime_timers',
    'wm_events'
  )
order by tablename;"
```

Initial result before applying pending migrations:

```text
driver_runs
runtime_timers
wm_events
```

Conclusion:

- local database is reachable;
- semantic run tables and `operator_audit_events` were not yet migrated in this
  database.

Follow-up command:

```bash
yarn workspace @a2arium/callagent-memory-sql db:migrate
```

Applied migrations:

```text
20260624120000_operator_semantic_read_model
20260624150000_operator_audit_events
```

Post-migration table probe:

```text
agent_run_edges
agent_runs
driver_runs
operator_audit_events
run_effects
runtime_timers
turn_runs
wm_events
```

Post-migration index probe confirmed the expected semantic/audit indexes,
including:

- `agent_runs_tenant_id_scope_updated_at_task_id_idx`;
- `agent_runs_tenant_id_agent_id_updated_at_task_id_idx`;
- `agent_runs_tenant_id_status_updated_at_task_id_idx`;
- `agent_runs_tenant_id_root_task_id_idx`;
- `agent_run_edges_tenant_id_root_task_id_parent_task_id_idx`;
- `agent_run_edges_tenant_id_child_task_id_idx`;
- `turn_runs_tenant_id_root_task_id_task_id_turn_seq_idx`;
- `run_effects_tenant_id_root_task_id_operation_updated_at_idx`;
- `operator_audit_events_tenant_id_created_at_idx`.

Conclusion:

- local database is now migrated for Phase 5D retention/audit and semantic read
  model evidence;
- real persisted 100k semantic-table evidence is now unblocked, but has not yet
  been run.

## 2026-06-24 — Retention Dry-Run Probe

Command:

```bash
yarn operator:retention -- --tenant default --dry-run
```

Initial results before the retention planner fix:

1. First run found an implementation bug: the retention planner selected both
   `id` and `eventId` for every model, which Prisma rejected for `driver_runs`.
2. The planner was fixed to select only the configured id field per target:
   `id` for `driver_runs`/`runtime_timers`/`operator_audit_events`, `eventId`
   for `wm_events`.
3. The documented Yarn `--` separator was fixed in the CLI parser.
4. Re-run then reached the database migration blocker:

```text
The table public.operator_audit_events does not exist in the current database.
```

Post-migration result:

```json
{
  "tenantId": "default",
  "dryRun": true,
  "apply": false,
  "policy": {
    "semanticDays": 365,
    "auditDays": 365,
    "debugDays": 7,
    "batchSize": 500
  },
  "tables": [
    { "table": "driver_runs", "retentionClass": "debug", "count": 0, "preserved": false, "applyEnabled": true },
    { "table": "runtime_timers", "retentionClass": "debug", "count": 0, "preserved": false, "applyEnabled": true },
    {
      "table": "wm_events",
      "retentionClass": "debug",
      "count": 33391,
      "preserved": false,
      "applyEnabled": false,
      "applyBlocker": "CALLAGENT_RETENTION_PRUNE_WM_EVENTS=true is required"
    },
    { "table": "operator_audit_events", "retentionClass": "audit", "count": 0, "preserved": true, "applyEnabled": true },
    {
      "table": "agent_runs",
      "retentionClass": "semantic",
      "count": 0,
      "preserved": true,
      "applyEnabled": false,
      "applyBlocker": "semantic summaries are preserved by Phase 5D"
    },
    {
      "table": "agent_run_edges",
      "retentionClass": "semantic",
      "count": 0,
      "preserved": true,
      "applyEnabled": false,
      "applyBlocker": "semantic summaries are preserved by Phase 5D"
    },
    {
      "table": "turn_runs",
      "retentionClass": "semantic",
      "count": 0,
      "preserved": true,
      "applyEnabled": false,
      "applyBlocker": "semantic summaries are preserved by Phase 5D"
    },
    {
      "table": "run_effects",
      "retentionClass": "semantic",
      "count": 0,
      "preserved": true,
      "applyEnabled": false,
      "applyBlocker": "semantic summaries are preserved by Phase 5D"
    }
  ]
}
```

Conclusion:

- retention unit coverage is passing;
- the CLI command path parses as documented;
- real DB dry-run passes after migration;
- 33,391 old raw `wm_events` are eligible by age, but apply is correctly blocked
  until explicit semantic-read readiness confirmation;
- semantic summaries are preserved by policy.

## 2026-06-24 — 100k Historical Query/Index Probe

Goal:

- validate the current semantic read-model index strategy for 100k historical
  run rows without mutating persistent local data.

Method:

- created session-local temporary tables shaped like the fleet/graph read paths;
- inserted:
  - 100,000 agent run rows;
  - 90,000 edge rows;
  - 100,000 turn rows;
- created indexes matching the committed semantic schema:
  - `(tenant_id, scope, updated_at, task_id)`;
  - `(tenant_id, agent_id, updated_at, task_id)`;
  - `(tenant_id, status, updated_at, task_id)`;
  - `(tenant_id, root_task_id)`;
  - `(tenant_id, root_task_id, parent_task_id)`;
  - `(tenant_id, root_task_id, task_id, turn_seq)`;
- ran `ANALYZE`;
- ran `EXPLAIN (ANALYZE, BUFFERS)` for fleet and graph access patterns.

Seed result:

```text
agent_runs: 100000
edges:       90000
turns:      100000
```

Query results:

| Query | Plan | Execution time |
|---|---|---:|
| root fleet page by recency | backward index scan on `(tenant_id, scope, updated_at, task_id)` | 0.116 ms |
| waiting-status fleet page | backward index scan on `(tenant_id, status, updated_at, task_id)` | 0.054 ms |
| agent-filter fleet page | backward index scan on `(tenant_id, agent_id, updated_at, task_id)` | 0.037 ms |
| root graph agent rows | index scan on `(tenant_id, root_task_id)` | 0.022 ms |
| root graph edge rows | index scan on `(tenant_id, root_task_id, parent_task_id)` | 0.019 ms |
| root graph turn rows | index-only scan on `(tenant_id, root_task_id, task_id, turn_seq)` | 0.035 ms |

Conclusion:

- the current semantic-table index shapes are directionally correct for 100k
  historical-row fleet and small-root graph access;
- this is not a full production load test because it uses temporary synthetic
  tables, no API server, no operator UI, no polling, no concurrent writers, and
  no real persisted migration;
- a real persisted dataset test remains required after the migration is applied.

## 2026-06-24 — Persisted 100k Semantic Dataset and Operator API Probe

Goal:

- validate actual persisted semantic tables and operator HTTP endpoints, not
  only temporary SQL tables.

Dataset:

- tenant: `perf-100k-20260624`;
- `agent_runs`: 120,000 total;
- root runs: 100,000;
- child runs: 20,000;
- `agent_run_edges`: 20,000;
- `turn_runs`: 220,000.

Seed timings:

| Insert | Rows | Time |
|---|---:|---:|
| root `agent_runs` | 100,000 | 6.248 s |
| child `agent_runs` | 20,000 | 1.245 s |
| `agent_run_edges` | 20,000 | 0.798 s |
| root `turn_runs` | 200,000 | 8.249 s |
| child `turn_runs` | 20,000 | 0.778 s |

SQL finding:

- root-only, status-filtered, agent-filtered, graph, edge, and turn queries used
  indexes and stayed under 10 ms;
- the include-children fleet query initially had no matching `(tenant_id,
  updated_at, id)` recency index and used a parallel seq scan:

```text
Parallel Seq Scan on agent_runs
Execution Time: 34.438 ms
```

Fix:

- added migration `20260624170000_operator_agent_runs_recency_index`;
- added index `agent_runs_tenant_id_updated_at_id_idx`.

Post-fix SQL result:

```text
Index Scan Backward using agent_runs_tenant_id_updated_at_id_idx
Execution Time: 0.485 ms
```

Runtime config for HTTP benchmark:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

HTTP benchmark:

- endpoint host: `http://127.0.0.1:8790`;
- tenant header: `x-tenant-id: perf-100k-20260624`;
- 10 sequential warm-ish requests per endpoint using `/usr/bin/curl`;
- times below are total HTTP request times from curl.

| Endpoint | First measured | Typical warm range | Response size |
|---|---:|---:|---:|
| `/agent-runs?scope=roots&limit=50` | 104 ms | 9-20 ms | 13.9 KB |
| `/agent-runs?scope=all&limit=50` | 21 ms | 8-20 ms | 13.6 KB |
| `/agent-runs?scope=roots&agentId=fetch-html&limit=50` | 30 ms | 8-23 ms | 13.5 KB |
| `/agent-runs?scope=roots&status=completed&limit=50` | 22 ms | 7-16 ms, one 34 ms outlier | 13.9 KB |
| `/tasks/perf-root-19999/run-graph` | 50 ms | 4-14 ms | 2.3 KB |

Conclusion:

- persisted 100k root-run API reads are viable locally with semantic projection
  mode after adding the all-scope recency index;
- root fleet API has a visible cold-start/connection cost, but warm local
  requests are within a workable range;
- include-children fleet reads would have been a production risk without the new
  `(tenant_id, updated_at, id)` index;
- this still is not a complete production load test: it uses one local operator
  client, no concurrent polling, no browser rendering measurement, no active
  worker load, and no external provider traffic.

## 2026-06-24 — Concurrent Polling and Browser Render Probe

Goal:

- validate concurrent operator polling and basic browser rendering against the
  persisted 100k semantic dataset.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Dataset:

- tenant: `perf-100k-20260624`;
- root runs: 100,000;
- total `agent_runs`: 120,000;
- `agent_run_edges`: 20,000;
- `turn_runs`: 220,000.

### Concurrent API Polling

Benchmark shape:

- 5 endpoints:
  - `/agent-runs?scope=roots&limit=50`;
  - `/agent-runs?scope=all&limit=50`;
  - `/agent-runs?scope=roots&agentId=fetch-html&limit=50`;
  - `/agent-runs?scope=roots&status=completed&limit=50`;
  - `/tasks/perf-root-19999/run-graph`;
- tenant header: `x-tenant-id: perf-100k-20260624`;
- Node `fetch`;
- one response body read per request.

20-concurrent result:

```json
{
  "concurrency": 20,
  "totalRequests": 200,
  "totalMs": 1468.86,
  "errors": [],
  "endpoints": {
    "roots": { "count": 40, "p50Ms": 69.6, "p95Ms": 653.08, "maxMs": 732.63 },
    "all": { "count": 40, "p50Ms": 67.07, "p95Ms": 618.0, "maxMs": 737.07 },
    "agent": { "count": 40, "p50Ms": 70.05, "p95Ms": 742.83, "maxMs": 760.22 },
    "status": { "count": 40, "p50Ms": 66.36, "p95Ms": 641.23, "maxMs": 780.46 },
    "graph": { "count": 40, "p50Ms": 67.41, "p95Ms": 553.84, "maxMs": 780.89 }
  }
}
```

10-concurrent result:

```json
{
  "concurrency": 10,
  "totalRequests": 100,
  "totalMs": 512.72,
  "errors": [],
  "endpoints": {
    "roots": { "count": 20, "p50Ms": 33.38, "p95Ms": 150.18, "maxMs": 153.4 },
    "all": { "count": 20, "p50Ms": 34.88, "p95Ms": 133.97, "maxMs": 134.47 },
    "agent": { "count": 20, "p50Ms": 28.92, "p95Ms": 140.18, "maxMs": 166.94 },
    "status": { "count": 20, "p50Ms": 32.64, "p95Ms": 152.24, "maxMs": 165.84 },
    "graph": { "count": 20, "p50Ms": 28.71, "p95Ms": 150.85, "maxMs": 166.14 }
  }
}
```

Metrics snapshot after polling:

```json
{
  "seriesCount": { "total": 5, "counters": 2, "gauges": 0, "durations": 3 },
  "alerts": [
    { "name": "api_p95:agent-runs", "state": "ok", "value": 409, "threshold": 2000 },
    { "name": "api_p95:agent-runs", "state": "ok", "value": 23, "threshold": 2000 },
    { "name": "api_p95:run-graph", "state": "ok", "value": 293, "threshold": 2000 }
  ],
  "requestCounts": {
    "agent-runs": 242,
    "run-graph": 61
  }
}
```

Conclusion:

- no API errors under 10 or 20 concurrent local pollers;
- 10 concurrent pollers are acceptable locally for this data shape;
- 20 concurrent pollers stay below the current 2s warning threshold, but p95
  rises into the 550-750 ms range and should not be treated as a final
  production capacity pass;
- this result is superseded by the profiling/fix pass below, which identified
  duplicate concurrent projection reads as the primary controllable cause.

### Browser Render

The gstack `browse` skill metadata is installed, but the `browse` binary was not
available in this environment and the repo does not include Playwright. Browser
render evidence used installed Google Chrome headless as a fallback.

Fleet render command shape:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new \
  --window-size=1440,1000 \
  --virtual-time-budget=8000 \
  --screenshot=/tmp/callagent-operator-100k-fleet.png \
  'http://127.0.0.1:8790/operator/?tenantId=perf-100k-20260624&scope=roots'
```

Run-detail render command shape:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new \
  --window-size=1440,1000 \
  --virtual-time-budget=8000 \
  --screenshot=/tmp/callagent-operator-100k-detail.png \
  'http://127.0.0.1:8790/operator/runs/perf-root-19999?tenantId=perf-100k-20260624&scope=roots'
```

Rendered artifacts:

- `/tmp/callagent-operator-100k-fleet.png`;
- `/tmp/callagent-operator-100k-detail.png`.

Observed:

- fleet page rendered with `Projection: semantic`;
- tenant input showed `perf-100k-20260624`;
- fleet table rendered 100 visible rows from the persisted semantic dataset;
- run detail rendered the semantic graph, root node, turn nodes, child node,
  edge, and inspector;
- no visible blank-state or catastrophic layout failure at 1440x1000.

Limitations:

- this was screenshot-based verification, not a Playwright trace;
- no automated DOM assertions or Core Web Vitals were captured;
- no mobile/tablet render check was run;
- Chrome emitted noisy updater logs unrelated to app behavior.

## 2026-06-24 — 20-Poller Projection Profile and Fix

Goal:

- identify why 20 concurrent operator pollers produced high p95 latency against
  the persisted 100k semantic dataset.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Profiling method:

- direct `pg` SQL benchmark against the same tenant and query shapes;
- API benchmark split into time-to-headers and body-read time;
- temporary env-gated projection phase logging with
  `CALLAGENT_OPERATOR_PROFILE=1`;
- mixed dashboard-shaped poller benchmark using:
  - `/agent-runs?scope=roots&limit=50`;
  - `/agent-runs?scope=all&limit=50`;
  - `/agent-runs?scope=roots&status=completed&limit=50`;
  - `/tasks/perf-root-19999/run-graph`.

Findings:

- response body read was not material: body-read p95 was about `0.1-0.2 ms`
  for ~13-14 KB fleet responses;
- list result mapping was not material: projection `mapMs` was generally
  `< 1 ms`;
- direct SQL after warmup was much lower than the original API tail, indicating
  app/projection query multiplication rather than JSON serialization;
- `listAgentRuns()` was doing redundant secondary reads from `agent_run_edges`
  and `turn_runs` even though `agent_runs` already stores the semantic counters
  needed by fleet rows;
- concurrent dashboard polling also caused identical in-flight list/graph reads
  to execute repeatedly, producing a thundering herd against Prisma/Postgres.

Changes made:

- semantic fleet list now uses denormalized `agent_runs` counters
  (`child_count`, `turn_count`, `llm_call_count`, `memory_op_count`) instead of
  re-aggregating edges/turns per page;
- semantic list tests now assert fleet list does not call edge/turn delegates;
- env-gated projection profiler added:
  - `CALLAGENT_OPERATOR_PROFILE=1`;
  - `CALLAGENT_OPERATOR_PROFILE_SLOW_MS=<ms>`;
- bounded in-flight single-flight added for identical semantic list/graph reads;
  entries are removed immediately after the shared promise settles;
- `CALLAGENT_OPERATOR_READ_SINGLE_FLIGHT=0` disables single-flight if needed.

Post-fix warm mixed 20-poller result:

```json
{
  "concurrency": 20,
  "totalRequests": 200,
  "errors": 0,
  "endpoints": {
    "fleet-roots": { "count": 50, "minMs": 3.7, "p50Ms": 9.8, "p95Ms": 130.7, "maxMs": 152.8 },
    "fleet-all": { "count": 50, "minMs": 2.7, "p50Ms": 7.2, "p95Ms": 116.1, "maxMs": 122.0 },
    "fleet-status": { "count": 50, "minMs": 4.9, "p50Ms": 9.1, "p95Ms": 134.7, "maxMs": 135.0 },
    "detail-graph": { "count": 50, "minMs": 15.2, "p50Ms": 31.0, "p95Ms": 137.4, "maxMs": 138.8 }
  }
}
```

Verification:

```bash
yarn jest packages/core/tests/operator.agentRunsList.test.ts \
  packages/core/tests/operator.runGraph.test.ts \
  --runInBand

yarn build
```

Result:

- targeted operator tests passed: 2 suites, 30 tests;
- full repository build passed: 20 packages.

Conclusion:

- the largest controllable source was repeated concurrent projection DB work;
- removing redundant fleet aggregation and coalescing identical in-flight reads
  moves the local 20-poller warm p95 from roughly `550-750 ms` to
  `116-137 ms`;
- this is still local-machine evidence, not a final hosted production capacity
  claim.

## 2026-06-24/25 — P2 Active Root Drill

Goal:

- verify real active parent/child runs against the Hatchet runtime and semantic
  operator projection, not only synthetic persisted rows;
- confirm root/child graph edges resolve terminal state when child completion is
  observed through child turn projection;
- confirm active await-child roots display as `waiting`, not `unknown`.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Payload shape:

- root agent: `fetch-page-router`;
- child agent: `fetch-html`;
- page type: `listing`;
- fetch mode: `static_html`;
- URL:
  `https://update-fixtures.staticdomains.app/pages/listing/static.html`;
- site config included listing access/items/pagination and a minimal detail
  extraction section required by the `fetch-page-router` input contract.

### 20-root drill

Root prefix:

```text
phase5-p2-20-active-1782405152643
```

Result:

- launched 20 real root tasks through `/rpc`;
- all 20 launches returned HTTP 200;
- each root delegated to one `fetch-html` child;
- active roots entered `waiting` while children ran;
- no root displayed `unknown`;
- all 20 roots completed;
- all 20 child nodes completed;
- each graph ended with 2 nodes, 1 edge, and 3 turns;
- all 20 final parent-child edges resolved to `completed`;
- terminal graph state was reached at poll tick 38.

Graph polling timing across 780 graph polls:

```json
{
  "count": 780,
  "p50Ms": 6.1,
  "p95Ms": 29.3,
  "maxMs": 1038.4
}
```

Final summary:

```json
{
  "launchCount": 20,
  "launchHttp": { "200": 20 },
  "launchErrors": 0,
  "sawWaiting": true,
  "sawUnknown": false,
  "terminalTick": 38,
  "finalRoots": { "completed": 20 },
  "finalEdgeStatuses": { "completed": 20 },
  "childStatuses": { "completed": 20 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]
}
```

Conclusion:

- the local P2 20-active-root gate passed for this `fetch-page-router` ->
  `fetch-html` workload;
- operator graph projection stayed coherent under active parent/child fanout;
- the `maxMs` graph poll outlier should be watched in later outage/restart
  drills, but p95 stayed well below the current 2s operator warning budget.

### 10-root drill

Root prefix:

```text
phase5-p2-fetch-page-router-1782329374154
```

Result:

- launched 10 real root tasks through the runtime API;
- each root delegated to one `fetch-html` child;
- all 10 roots completed;
- all 10 child nodes completed;
- each graph ended with 2 nodes, 1 edge, and 3 turns;
- each final parent-child edge resolved to `completed`;
- no API launch errors.

Graph polling timing across 50 graph polls:

```json
{
  "count": 50,
  "p50Ms": 39.7,
  "p95Ms": 110.3,
  "maxMs": 121.8
}
```

Issues found and fixed:

- child edges could remain `running` when the child reached terminal state via
  child `turn.completed` projection but no parent `task.child_completed` event
  was present. Semantic projection now resolves matching
  `agent_run_edges.child_task_id` rows when a child task is projected terminal.
- active await-child roots were shown as `unknown` because `waiting` was missing
  from the core and operator-viewer status normalization contracts. `waiting` is
  now a first-class `AgentRunStatus` in core projection, graph normalization, and
  operator UI normalization.

### Waiting-status regression smoke

Root prefix:

```text
phase5-p2-waiting-smoke-1782329873917
```

Result:

- launched 3 real root tasks through `/rpc`;
- all three roots entered `waiting` while their `fetch-html` children ran;
- no root ever displayed `unknown`;
- all three roots completed;
- all three child nodes completed;
- all three final parent-child edges resolved to `completed`.

Graph polling timing across 117 graph polls:

```json
{
  "count": 117,
  "p50Ms": 6.6,
  "p95Ms": 26.1,
  "maxMs": 118.5
}
```

Verification:

```bash
yarn jest packages/core/tests/operator.agentRunsList.test.ts \
  packages/core/tests/operator.runGraph.test.ts \
  --runInBand

yarn workspace @a2arium/operator-viewer test src/domain/derive.test.ts

yarn workspace @a2arium/operator-viewer build

yarn build
```

Result:

- targeted core operator tests passed: 2 suites, 31 tests;
- operator-viewer status/domain tests passed: 1 suite, 6 tests;
- operator-viewer production build passed;
- full repository build passed: 20 packages.

Limitations:

- this drill did not include runtime kill/restart, Hatchet/Postgres/NATS
  interruption, cancellation, timeout, or missing-child-wake scenarios;
- this is local-machine evidence, not a hosted production capacity claim.

## 2026-06-25 — P3 Runtime Kill/Restart Drill

Goal:

- kill the runtime while real parent/child runs are active;
- restart the runtime worker;
- verify active work resumes or reaches terminal state coherently;
- verify operator projection does not leave stale `waiting`, `running`, or
  `unknown` states after restart.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Root prefix:

```text
phase5-p3-runtime-restart-1782405279624
```

Pre-kill state:

- launched 8 real `fetch-page-router` roots through `/rpc`;
- each root used the same static fixture payload as the P2 active-root drill;
- all 8 launches returned HTTP 200;
- immediately before the kill, operator graph projection showed:

```json
{
  "roots": { "waiting": 6, "running": 2 },
  "edges": { "running": 6 },
  "minNodes": 1,
  "maxNodes": 2
}
```

Kill/restart action:

- terminated the runtime host/worker process tree while the batch was active:

```bash
kill -9 <runtime-host-and-worker-pids>
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Post-restart result:

- the restarted worker picked up outstanding Hatchet work;
- first post-restart graph poll already showed all roots terminal;
- all 8 roots completed;
- all 8 child `fetch-html` nodes completed;
- all 8 final parent-child edges resolved to `completed`;
- no post-restart graph read showed `unknown`.

Graph polling timing across 8 post-restart graph polls:

```json
{
  "count": 8,
  "p50Ms": 10.7,
  "p95Ms": 15.8,
  "maxMs": 558.2
}
```

Final summary:

```json
{
  "ids": 8,
  "sawUnknown": false,
  "sawWaitingAfterRestart": false,
  "terminalTick": 0,
  "finalRoots": { "completed": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3]
}
```

Conclusion:

- runtime kill/restart recovered this active parent/child workload coherently;
- no stale operator `waiting`, `running`, or `unknown` state remained after
  terminal outcomes;
- this does not yet cover Hatchet, Postgres, or NATS interruption.

## 2026-06-25 — P3 Hatchet Engine Interruption Drill

Goal:

- stop Hatchet engine while real parent/child runs are active;
- restart Hatchet engine;
- verify durable parent `agent.run` rows do not duplicate child delegation;
- verify all roots, children, and semantic graph edges reach terminal state.

Repeatable script:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix <prefix> \
  --count 8 \
  --interrupt-hatchet true \
  --poll-ms 2000 \
  --max-polls 90
```

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

### First attempt exposed duplicate delegation

Root prefix:

```text
phase5-p3-hatchet-interrupt-1782405428681
```

Result:

- launched 8 real `fetch-page-router` roots through `/rpc`;
- stopped `hatchet-engine` while roots were waiting on `fetch-html` children;
- restarted `hatchet-engine`;
- all 8 roots eventually completed, but one root produced 3 nodes, 2 child
  edges, and 5 turns instead of the expected 2 nodes, 1 edge, and 3 turns.

Root cause:

- after the engine interruption, durable parent `agent.run` could re-enter from
  its initial `start` wake even though the persisted root had already reached an
  `await_child` boundary;
- the driver only looked for parent `task.child_completed` events before
  waiting, but Hatchet-mode child completion currently pushes the Hatchet wake
  event and does not append a parent `task.child_completed` event;
- when the Hatchet wake replay returned an empty payload after interruption,
  the parent resumed with `child.output === undefined`; the agent interpreted
  that as empty child content and delegated a second child.

Fix:

- durable parent startup now checks the latest persisted root `turn.completed`
  event; if it is an await boundary, startup waits/resumes that boundary instead
  of running another `start` segment;
- await-child recovery now falls back from parent `task.child_completed` /
  `task.child_failed` events to the persisted `task.child_started` child task
  id and the child task's own terminal `turn.completed` / `task.completed` /
  `task.failed` event;
- empty Hatchet child wake replay is hydrated from persisted child terminal
  output before running the resume segment.

Regression coverage:

```bash
yarn test packages/driver-hatchet/tests/task.test.ts
yarn build
```

Result:

- targeted driver task suite passed: 22 tests;
- full repository build passed: 20 packages.

### Passing rerun

Root prefix:

```text
phase5-p3-hatchet-interrupt-fixed2-1782406950000
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 1;
- stopped `hatchet-engine`;
- waited 8 seconds;
- restarted `hatchet-engine`;
- continued polling operator graph projection until terminal.

Final summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 1,
  "terminalTick": 10,
  "finalRoots": { "completed": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3],
  "duplicateChildEdges": []
}
```

Persisted event count check:

```text
roots=8
child_started=8
min_child_started=1
max_child_started=1
root_turn_completed=16
```

Graph polling timing across 104 graph polls:

```json
{
  "count": 104,
  "p50Ms": 46,
  "p95Ms": 956.5,
  "maxMs": 987.5
}
```

Conclusion:

- Hatchet engine stop/start recovered this active parent/child workload
  coherently after the driver fix;
- durable parent re-entry no longer duplicated child delegation;
- empty Hatchet child wake replay no longer causes a second child call when
  persisted child terminal output exists;
- no stale operator `waiting`, `running`, or `unknown` state remained after
  terminal outcomes;
- p95 graph polling stayed below the current 2s operator warning budget, but is
  noticeably slower than the warm non-interruption drill and should remain on
  the performance watch list.

## 2026-06-25 — P3 NATS Interruption Drill

Goal:

- stop NATS while real parent/child runs are active;
- restart NATS;
- verify Hatchet/event-bus recovery does not leave parent roots waiting forever;
- verify all roots, children, and semantic graph edges reach terminal state.

Command:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix phase5-p3-nats-interrupt-1782410000000 \
  --count 8 \
  --interrupt-service nats \
  --poll-ms 2000 \
  --max-polls 90
```

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 2;
- stopped the Compose `nats` service;
- waited 8 seconds;
- restarted `nats`;
- continued polling operator graph projection until terminal.

Final summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 2,
  "terminalTick": 1,
  "finalRoots": { "completed": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3],
  "duplicateChildEdges": []
}
```

Persisted event count check:

```text
roots=8
child_started=8
min_child_started=1
max_child_started=1
root_turn_completed=16
```

Graph polling timing across 40 graph polls:

```json
{
  "count": 40,
  "p50Ms": 125.2,
  "p95Ms": 223.6,
  "maxMs": 277.3
}
```

Conclusion:

- NATS stop/start recovered this active parent/child workload coherently;
- no duplicate child delegation was observed;
- no stale operator `waiting`, `running`, or `unknown` state remained after
  terminal outcomes;
- this is local Compose evidence, not a hosted multi-node broker availability
  claim.

## 2026-06-25 — P3 Root Cancellation Drill

Goal:

- cancel real root runs while they are waiting on active child agents;
- verify cancellation is persisted as a semantic terminal state;
- verify late child/turn events do not reopen canceled roots as `waiting`;
- verify the graph eventually reaches an idle terminal state with no active
  child edges or child nodes.

Command:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix phase5-p3-root-cancel-strict-1782414700000 \
  --count 8 \
  --cancel-roots true \
  --poll-ms 2000 \
  --max-polls 90
```

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

### First attempts exposed stale waiting projection

Root prefixes:

```text
phase5-p3-root-cancel-1782411800000
phase5-p3-root-cancel-fixed-1782414100000
```

Findings:

- initial cancellation returned HTTP 500 for one root and left seven roots
  semantically `waiting`;
- durable cancellation metadata was saved in the task snapshot, but no
  `task.canceled` working-memory event was appended, so the semantic projection
  had no terminal event to consume;
- provider cancellation errors could escape the cancel API even after durable
  cancellation intent had been saved;
- after adding `task.canceled`, all eight roots received the event, but late
  `turn.completed` / child events could still downgrade some semantic rows from
  `canceled` back to `waiting`.

Fix:

- `TaskEngine.cancelTask` now appends a `task.canceled` event after saving the
  durable cancellation marker;
- provider cancellation is best-effort after the durable marker is saved, so a
  provider cleanup race no longer turns the operator cancel request into HTTP
  500;
- semantic projection handles `task.canceled` as a terminal run state;
- semantic projection now preserves terminal run states (`completed`, `failed`,
  `canceled`) when late non-terminal events arrive;
- the live drill script now waits for terminal roots and an idle child graph on
  cancellation runs.

Regression coverage:

```bash
yarn test packages/core/tests/operator.agentRunsList.test.ts
yarn test packages/core/tests/taskEngine.coverage.test.ts -t cancelTask
yarn build
```

Result:

- semantic projection suite passed: 17 tests;
- targeted cancel-task suite passed: 5 tests;
- full repository build passed: 20 packages.

### Passing strict rerun

Root prefix:

```text
phase5-p3-root-cancel-strict-1782414700000
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 1;
- canceled all 8 roots through the operator cancel API;
- continued polling until all roots were terminal and child nodes/edges were no
  longer active.

Final summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 1,
  "terminalTick": 8,
  "finalRoots": { "canceled": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "duplicateChildEdges": []
}
```

Persisted event count check:

```text
roots=8
canceled_events=8
child_started=8
min_child_started=1
max_child_started=1
turn_completed=8
```

Semantic read-model terminal check:

```text
children completed=8
edges completed=8
roots canceled=8
```

Graph polling timing across 88 graph polls:

```json
{
  "count": 88,
  "p50Ms": 23.8,
  "p95Ms": 66.4,
  "maxMs": 85.2
}
```

Conclusion:

- root cancellation now persists and projects a terminal `canceled` state;
- late child/turn events no longer reopen canceled roots as `waiting`;
- no stale operator `waiting`, `running`, or `unknown` state remained after
  terminal outcomes;
- root cancellation is semantic cancellation of the parent run. In this drill,
  already-started child runs were allowed to complete and the graph settled with
  completed child nodes/edges under canceled roots.

## 2026-06-25 — P3 Missing Child Wake Drill

Goal:

- prove a parent waiting on `await_child` does not wait forever when the Hatchet
  child wake event is missing;
- verify the durable parent recovers from persisted child terminal facts;
- verify no duplicate child delegation is created during recovery;
- verify roots, children, and edges converge to terminal semantic state.

Implementation hardening:

- await-child waits now race the Hatchet child event against a configurable
  watchdog sleep;
- when the watchdog wins, the parent checks persisted `task.child_started` plus
  child terminal `turn.completed` / `task.completed` / `task.failed` events;
- if persisted child terminal output exists, the parent resumes from that data
  instead of waiting indefinitely for the missing Hatchet event;
- a scoped drill switch,
  `CALLAGENT_HATCHET_SUPPRESS_CHILD_WAKE_PREFIX=<prefix>`, can suppress the
  provider child wake for matching parent task ids without mutating database
  rows by hand.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic \
CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS=2000 \
CALLAGENT_HATCHET_SUPPRESS_CHILD_WAKE_PREFIX=phase5-p3-missing-child-wake-1782417200000 \
yarn runtime --no-dashboard
```

Command:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix phase5-p3-missing-child-wake-1782417200000 \
  --count 8 \
  --poll-ms 2000 \
  --max-polls 90
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 1;
- all provider child wake events for those roots were suppressed by prefix;
- continued polling until the watchdog recovered from persisted child terminal
  facts and all roots completed.

Final summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 1,
  "terminalTick": 5,
  "finalRoots": { "completed": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3],
  "duplicateChildEdges": []
}
```

Persisted event count check:

```text
roots=8
child_started=8
parent_child_completed=0
min_child_started=1
max_child_started=1
root_turn_completed=16
```

Semantic read-model terminal check:

```text
children completed=8
edges completed=8
roots completed=8
```

Graph polling timing across 64 graph polls:

```json
{
  "count": 64,
  "p50Ms": 23.9,
  "p95Ms": 118.4,
  "maxMs": 119.3
}
```

Verification:

```bash
yarn test packages/driver-hatchet/tests/task.test.ts
yarn build
```

Result:

- targeted driver task suite passed: 23 tests;
- full repository build passed: 20 packages.

Conclusion:

- missing Hatchet child wake recovery works for this parent/child workload;
- parents did not wait forever despite zero persisted parent
  `task.child_completed` events;
- persisted child terminal facts were sufficient to resume all roots;
- no duplicate child delegation or stale `waiting`, `running`, or `unknown`
  projection remained after terminal outcomes.

## 2026-06-25 — P3 Child Wait Timeout Drill

Goal:

- prove a parent waiting on `await_child` does not wait forever when neither the
  Hatchet child wake nor persisted child terminal recovery is available;
- verify the parent reaches a readable terminal failure;
- verify child and edge projection still converges after child completion;
- verify root finalization persists semantic `complete ok:false` error details.

Implementation hardening:

- await-child watchdog waits now have a configured maximum wait,
  `CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS`, defaulting to 25 minutes;
- when the maximum wait is exceeded, the parent receives an `ok:false` child
  wake with `CHILD_WAKE_TIMEOUT`;
- root driver-run finalization now preserves error metadata for terminal
  `complete` boundaries whose result is `ok:false`;
- a scoped drill switch,
  `CALLAGENT_HATCHET_SUPPRESS_CHILD_TERMINAL_RECOVERY_PREFIX=<prefix>`, can
  suppress persisted child-terminal recovery for matching parent task ids. This
  is failure injection only; normal runtime still recovers from persisted child
  terminal facts.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic \
CALLAGENT_AWAIT_CHILD_RECOVERY_INTERVAL_MS=1000 \
CALLAGENT_AWAIT_CHILD_MAX_WAIT_MS=3000 \
CALLAGENT_HATCHET_SUPPRESS_CHILD_WAKE_PREFIX=phase5-p3-child-timeout-1782419000000 \
CALLAGENT_HATCHET_SUPPRESS_CHILD_TERMINAL_RECOVERY_PREFIX=phase5-p3-child-timeout-1782419000000 \
yarn runtime --no-dashboard
```

Command:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix phase5-p3-child-timeout-1782419000000 \
  --count 8 \
  --poll-ms 2000 \
  --max-polls 90
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 1;
- provider child wake and persisted child terminal recovery were both
  suppressed by prefix;
- the parent wait timed out and resumed each root with an `ok:false` child wake;
- follow-up settled-state checks were run after children completed.

Initial timeout summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 1,
  "terminalTick": 3,
  "finalRoots": { "failed": 8 },
  "finalEdgeStatuses": { "running": 8 },
  "childStatuses": { "running": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3],
  "duplicateChildEdges": [],
  "graphPollTiming": {
    "count": 48,
    "p50Ms": 39.4,
    "p95Ms": 149.3,
    "maxMs": 157.5
  }
}
```

Settled semantic read-model check:

```text
agent_runs:
  child completed=8
  root failed=8

agent_run_edges:
  completed=8

turn_runs:
  completed=16
  failed=8

wm_events:
  task.child_started=8
  task.started=8
  turn.started=16
  turn.completed=16
```

Root terminal messages:

```text
terminal_code=ALL_MODES_FAILED
terminal_message=All fetch modes failed. Last error: Timed out waiting for child wake for token <token>.
```

Driver-run finalization check:

```text
status=failed
boundary_kind=complete
error={"code":"ALL_MODES_FAILED","message":"All fetch modes failed. Last error: Timed out waiting for child wake for token <token>."}
```

Operator graph API spot check:

```text
root.status=failed
root.error.code=ALL_MODES_FAILED
child.status=completed
edge.status=completed
projection.source=semantic
projection.partial=false
```

Verification:

```bash
yarn test packages/driver-hatchet/tests/task.test.ts
yarn build
```

Result:

- targeted driver task suite passed: 24 tests;
- full repository build passed: 20 packages.

Conclusion:

- unrecoverable missing child wake does not wait forever;
- parent failure is terminal and readable in the operator graph and driver-run
  metadata;
- late child completion still settles child and edge projection cleanly;
- no duplicate child delegation was observed.

## 2026-06-25 — P3 Postgres Connection Interruption Drill

Goal:

- exercise active real-agent parent/child runs while existing runtime DB
  connections are interrupted;
- verify Prisma/runtime reconnect behavior without stopping the local Postgres
  app;
- verify roots, child nodes, child edges, and turns converge to terminal
  completed state;
- verify no duplicate child delegation or stale active/unknown semantic state
  remains.

Implementation hardening:

- `phase5-live-drill.mjs` now supports
  `--interrupt-postgres-connections true`;
- the drill reads `MEMORY_DATABASE_URL` from the environment or repo `.env`;
- interruption terminates current DB sessions for the configured agent database
  and current user with `pg_terminate_backend`, leaving the Postgres server
  process running.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Command:

```bash
node apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs \
  --prefix phase5-p3-postgres-terminate-1782421800000 \
  --count 8 \
  --poll-ms 2000 \
  --max-polls 90 \
  --interrupt-postgres-connections true
```

Action:

- launched 8 real `fetch-page-router` roots;
- all 8 roots reached `waiting` with 8 running child edges by poll tick 1;
- terminated 20 existing Postgres connections to the `agent` database;
- continued graph polling until all roots, children, and edges completed.

Final summary:

```json
{
  "launchHttp": { "200": 8 },
  "launchErrors": 0,
  "activeTick": 1,
  "terminalTick": 23,
  "finalRoots": { "completed": 8 },
  "finalEdgeStatuses": { "completed": 8 },
  "childStatuses": { "completed": 8 },
  "finalNodeCounts": [2, 2, 2, 2, 2, 2, 2, 2],
  "finalEdgeCounts": [1, 1, 1, 1, 1, 1, 1, 1],
  "finalTurnCounts": [3, 3, 3, 3, 3, 3, 3, 3],
  "duplicateChildEdges": [],
  "postgresTerminatedConnections": 20,
  "graphPollTiming": {
    "count": 208,
    "p50Ms": 35.7,
    "p95Ms": 230.6,
    "maxMs": 291.7
  }
}
```

Settled semantic read-model check:

```text
agent_runs:
  completed=16

agent_run_edges:
  completed=8

turn_runs:
  completed=24

active_or_unknown=0
duplicate child edges=0
```

Persisted event count check:

```text
task.started=8
task.child_started=8
turn.started=16
turn.completed=16
```

Driver-run check:

```text
driver_runs completed=32
```

Operator graph API spot check:

```text
root.status=completed
child.status=completed
edge.status=completed
projection.source=semantic
projection.partial=false
```

Verification:

```bash
node --check apps/docs/orchestrator-harness/scripts/phase5-live-drill.mjs
```

Conclusion:

- active parent/child runs recovered from terminated DB sessions;
- no stale `waiting`, `running`, `unknown`, or `stuck` semantic state remained;
- no duplicate child edge was created;
- graph polling p95 stayed under 250 ms during the interruption run.

## 2026-06-26 — Operator Browser Stale-State Proof

Goal:

- verify the operator detail page in a real browser after the Postgres
  interruption drill;
- assert the user-visible graph/inspector state matches the semantic API;
- capture browser timing, console health, and screenshot evidence for stale
  state regressions.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic yarn runtime --no-dashboard
```

Task checked:

```text
phase5-p3-postgres-terminate-1782421800000-01
```

Browser command:

```bash
/Users/maximantonov/.codex/skills/gstack/browse/dist/browse chain \
  'goto http://127.0.0.1:8790/operator/runs/phase5-p3-postgres-terminate-1782421800000-01?tenantId=default&nodeId=phase5-p3-postgres-terminate-1782421800000-01&tab=summary | wait --networkidle | text | screenshot /tmp/callagent-phase5-operator-stale-state-proof.png | perf | console --errors'
```

Browser evidence:

- screenshot: `/tmp/callagent-phase5-operator-stale-state-proof.png`;
- page loaded with HTTP 200;
- root graph node visible as `Completed`;
- child `fetch-html` graph node visible as `Completed`;
- selected-agent inspector visible as `Completed`;
- turn nodes visible as completed / await-child resolved;
- no visible `Waiting`, `Running`, `Unknown`, or `Stuck` terminal-state leak;
- no terminal `Cancel run` / selected-agent `Cancel` control is visible;
- no browser console errors;
- load timing:

```text
dns       0 ms
tcp       1 ms
ttfb     16 ms
domReady 166 ms
load     166 ms
total    166 ms
```

API spot check for the same task:

```text
root.status=completed
child.status=completed
edge.status=completed
root.turns=2
child.turns=1
projection.source=semantic
projection.partial=false
```

Issue found and fixed:

- terminal completed run-detail pages still rendered disabled cancel controls in
  the header and selected-agent inspector;
- the detail page now renders root/agent cancel controls only for non-terminal
  runs, while preserving the selected node and inspector state.

Verification:

```bash
yarn build
```

Conclusion:

- the browser-visible operator state matches the semantic API for the
  Postgres-interruption recovery task;
- the page no longer exposes cancel controls for terminal completed runs;
- this is still a local browser proof, not a hosted production browser trace.

## 2026-06-26 — Phase 5C P5 Provider Enqueue Failure Drill

Goal:

- prove Hatchet provider enqueue failures are observable and not silent;
- verify metrics, semantic incidents, and operator UI all show the failure;
- ensure a provider enqueue failure terminalizes the semantic root run rather
  than leaving stale `running` state.

Runtime config:

```bash
CALLAGENT_OPERATOR_PROJECTION_READ=semantic \
CALLAGENT_DRIVER_SURFACES=start \
yarn runtime --no-dashboard
```

Induced failure:

```bash
docker compose -f apps/hatchet-poc/docker-compose.yml --env-file .env stop hatchet-engine
```

Task:

```text
phase5c-p5-provider-enqueue-fixed-1782456170000-01
```

RPC result:

```text
HTTP 200 JSON-RPC result
status.state=failed
message=Task execution failed: /WorkflowService/TriggerWorkflow UNAVAILABLE...
```

Metrics excerpt:

```json
{
  "seriesCount": { "total": 11, "counters": 7, "gauges": 3, "durations": 1 },
  "droppedSeriesCount": 0,
  "counters": [
    {
      "name": "hatchet.enqueue_total",
      "count": 1,
      "dimensions": {
        "operation": "agent.run",
        "status": "failed",
        "errorCode": "HatchetError"
      }
    }
  ],
  "alerts": [
    {
      "name": "api_p95:rpc",
      "state": "warning",
      "value": 80245,
      "threshold": 2000
    }
  ]
}
```

Operator graph API spot check:

```text
root.status=failed
node.status=failed
turns=0
edges=0
effects included observability.provider_enqueue_failed status=failed
effect.error.code=HatchetError
projection.source=semantic
projection.partial=false
```

Browser proof:

```bash
/Users/maximantonov/.codex/skills/gstack/browse/dist/browse chain \
  'goto http://127.0.0.1:8790/operator/runs/phase5c-p5-provider-enqueue-fixed-1782456170000-01?tenantId=default&nodeId=phase5c-p5-provider-enqueue-fixed-1782456170000-01&tab=summary | wait --networkidle | text | screenshot /tmp/callagent-phase5c-p5-provider-enqueue-failure.png | console --errors'
```

Observed:

- screenshot: `/tmp/callagent-phase5c-p5-provider-enqueue-failure.png`;
- page loaded with HTTP 200;
- header, graph node, and selected-agent inspector showed `Failed`;
- summary showed the Hatchet enqueue runtime error;
- failed `observability.provider_enqueue_failed` effects were visible;
- no browser console errors.

Issue found and fixed:

- first attempt recorded enqueue-failure metrics and observability effects, but
  left the semantic root run `running`;
- root cause: non-streaming `TaskEngine.startTask` caught scheduling failure and
  returned a failed `TaskEntity` without appending `task.failed`;
- fix: non-streaming caught failures now append `task.failed` and a final failed
  `task.status` outbox row before returning.

Verification:

```bash
yarn jest packages/core/tests/runtime/taskEngineDriverRouting.test.ts --runInBand
yarn jest packages/driver-hatchet/tests/hatchetRuntimeDriver.test.ts --runInBand
yarn build
```

Restoration:

```bash
docker compose -f apps/hatchet-poc/docker-compose.yml --env-file .env up -d hatchet-engine
```

Conclusion:

- provider enqueue failure is visible in metrics, semantic effects, graph API,
  and browser UI;
- metric cardinality remained bounded (`droppedSeriesCount=0`);
- semantic root state no longer leaks as stale `running` after start-scheduling
  failure;
- RPC latency warning correctly fired because the Hatchet SDK failure path took
  about 80 seconds locally.

## 2026-06-26 — Phase 5 Closure Verification

Purpose:

- close Phase 5 after Opik removal and confirm the final observability boundary;
- verify generic telemetry, `/metrics`, operator build, and workspace build still
  pass;
- record that callagent no longer owns Opik integration.

Boundary:

- kept in callagent: `TelemetryProvider`, `ConsoleProvider`,
  `CallagentBridgeProvider`, TurnTrace capture, semantic operator events, and
  JSON `/metrics`;
- removed from callagent: built-in Opik provider, Opik env flags, Opik dashboard
  links, Opik payload sanitizer, and Opik-specific tests;
- retained outside callagent: Opik remains a transitive `callllm` dependency in
  `yarn.lock`, which is intentional because full prompt/response telemetry is
  delegated to callllm/application-level instrumentation.

Reference scan:

```bash
rg -n "Opik|opik|CALLAGENT_OPIK|CALLAGENT_DEBUG_TURN_OPIK|OPIK_|VITE_OPIK|sanitizeForOpikPayload|turnOpikDiagEnabled" \
  --glob '!apps/docs/todo/done/**' \
  --glob '!apps/docs/orchestrator-harness/implementation-status.md' \
  --glob '!apps/docs/orchestrator-harness/production-readiness.md' \
  --glob '!apps/docs/orchestrator-harness/production-readiness-evidence.md' \
  --glob '!test_results.json' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!**/.turbo/**'
```

Observed:

- no active callagent source, operator source, runtime-host config, Jest setup,
  or product/spec harness-doc references remain;
- closure/status docs mention Opik only to record the removal decision and final
  telemetry boundary;
- remaining hits are only `yarn.lock` transitive `opik` entries from `callllm`.

Verification:

```bash
yarn jest packages/core/tests/turnTrace.telemetry.test.ts packages/core/tests/LLMCallerAdapter.typed.test.ts packages/core/tests/observability.metrics.test.ts --runInBand
yarn workspace @a2arium/operator-viewer build
yarn build
git diff --check
```

Observed:

- focused telemetry/metrics tests passed: 3 suites, 9 tests;
- operator production build passed; Vite still reports the known large chunk
  warning;
- full workspace build passed: 20 successful packages;
- diff whitespace check passed.

Conclusion:

- Phase 5C remains complete without Opik because the committed scope is bounded
  generic telemetry plus `/metrics` JSON;
- Phase 5A-5D are complete for the local harness gate;
- hosted/staging browser evidence and deployment-specific metrics export are
  Phase 6 or deployment-readiness follow-ups, not Phase 5 blockers.

## Remaining Evidence Needed

- Add repo-owned browser automation if promotion requires hermetic CI browser
  checks rather than local gstack browse/Chrome evidence.
- Run a hosted/staging browser trace after deployment; current browser evidence
  is local only.
