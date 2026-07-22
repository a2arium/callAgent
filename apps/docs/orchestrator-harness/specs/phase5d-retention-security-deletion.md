# Phase 5D — Retention, Security, Audit, and Deletion Gates

Phase 5D makes the operator harness safer to run outside local development. It
adds enforceable operator auth, durable audit records, retention classes, and a
per-surface deletion gate for legacy in-process coordination code.

## Operator Auth

- Observer uses named email/password identities and database sessions provided
  by Better Auth.
- Human routes live under `/operator-api`; `/rpc` remains a separate machine
  protocol surface.
- `x-tenant-id` is accepted only after the session's active tenant membership
  and role are checked. Observer RPC payload tenant ids are overwritten.
- Production requires `MEMORY_DATABASE_URL`, `BETTER_AUTH_SECRET`, and
  `CALLAGENT_PUBLIC_URL` and fails closed when they are missing.

Protected surfaces:

- `/operator-api/agent-runs`
- `/operator-api/agents`
- `/operator-api/tasks/*`
- `/operator-api/memory/*`
- `/operator-api/artifacts/*`
- `/operator-api/rpc`
- `/operator-api/access/*`

## Audit Records

Destructive and raw-payload operator actions write `operator_audit_events`.

Initial audited actions:

- `run.cancel`
- `agent.cancel`
- `payload.launch`
- `delete`

Audit rows are tenant scoped and contain actor, target ids, reason, accepted
state, result status, error code, child propagation, metadata, and request time.
In production, destructive/raw-payload actions fail closed if the audit record
cannot be written.

## Retention Policy

Default retention classes:

| Class | Data | Default |
|---|---|---:|
| semantic | `agent_runs`, `agent_run_edges`, `turn_runs`, `run_effects` | 365 days, preserved by Phase 5D |
| audit | `operator_audit_events` | 365 days |
| debug | `driver_runs`, terminal `runtime_timers` | 7 days |
| raw events | `wm_events` | 7 days, apply requires `CALLAGENT_RETENTION_PRUNE_WM_EVENTS=true` |

The retention command defaults to dry-run:

```sh
yarn operator:retention -- --tenant default --dry-run
```

Apply mode requires both an explicit flag and environment confirmation:

```sh
CALLAGENT_RETENTION_APPLY=true yarn operator:retention -- --tenant default --apply
```

Apply mode writes an audit record before deleting, deletes in bounded batches,
then writes an applied audit record. Phase 5D does not prune semantic summaries,
so old runs remain intelligible after raw/debug data expires.

Outbox rows are not pruned in Phase 5D because the current schema does not
distinguish pending from resolved rows.

## Deletion Gates

Legacy in-process orchestration code may be deleted only per surface. A surface
must have:

- parity test evidence;
- failure drill evidence;
- rollback flag;
- metrics coverage;
- retention behavior;
- approver and approval date.

The current registry keeps all legacy surfaces as candidates until evidence is
complete. No global deletion approval exists.

## Acceptance

Phase 5D is complete when:

- production operator auth fails closed without a token;
- all operator endpoints normalize and enforce tenant scope;
- cancel and raw-payload launch are audited;
- retention dry-run reports candidates without deleting semantic summaries;
- retention apply deletes only eligible debug rows in bounded batches;
- raw `wm_events` pruning is blocked until semantic-read readiness is explicitly
  confirmed;
- deletion-gate tests prevent approved/deleted status without evidence.
