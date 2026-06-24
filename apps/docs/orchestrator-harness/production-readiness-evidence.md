# Production Readiness Evidence

Status: active evidence ledger.
Last updated: 2026-06-24.

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

## Remaining Evidence Needed

- Run concurrent operator polling against the persisted 100k dataset.
- Measure browser/operator UI render behavior against the persisted 100k
  dataset.
- Run 10-20 active parallel real agent tasks with child agents.
- During that active run, exercise:
  - runtime kill/restart;
  - Hatchet/Postgres/NATS interruption where practical;
  - cancellation;
  - missing child wake;
  - timeout.
- Capture operator screenshots or API responses proving no stale
  waiting/running state remains after terminal outcomes.
