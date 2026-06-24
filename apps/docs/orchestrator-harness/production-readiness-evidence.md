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

Result:

```text
driver_runs
runtime_timers
wm_events
```

Conclusion:

- local database is reachable;
- semantic run tables and `operator_audit_events` are not yet migrated in this
  database;
- real retention dry-run and real persisted 100k semantic-table testing are
  blocked until the Phase 5D migration is applied.

## 2026-06-24 — Retention Dry-Run Probe

Command:

```bash
yarn operator:retention -- --tenant default --dry-run
```

Results:

1. First run found an implementation bug: the retention planner selected both
   `id` and `eventId` for every model, which Prisma rejected for `driver_runs`.
2. The planner was fixed to select only the configured id field per target:
   `id` for `driver_runs`/`runtime_timers`/`operator_audit_events`, `eventId`
   for `wm_events`.
3. The documented Yarn `--` separator was fixed in the CLI parser.
4. Re-run now reaches the database migration blocker:

```text
The table public.operator_audit_events does not exist in the current database.
```

Conclusion:

- retention unit coverage is passing;
- the CLI command path parses as documented;
- real DB dry-run remains blocked until the migration creating
  `operator_audit_events` is applied.

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

## Remaining Evidence Needed

- Apply the Phase 5D migration to the target local/staging database.
- Re-run `yarn operator:retention -- --tenant default --dry-run` against the
  migrated database and record the JSON plan.
- Run API-level fleet and run-graph queries against a migrated 100k persisted
  semantic dataset, not only temporary SQL tables.
- Run 10-20 active parallel real agent tasks with child agents.
- During that active run, exercise:
  - runtime kill/restart;
  - Hatchet/Postgres/NATS interruption where practical;
  - cancellation;
  - missing child wake;
  - timeout.
- Capture operator screenshots or API responses proving no stale
  waiting/running state remains after terminal outcomes.
