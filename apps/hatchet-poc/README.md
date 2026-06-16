# Hatchet POC — Scenario 1 (outbox dispatch)

Self-hosted Hatchet + NATS + callAgent Postgres for manual gates **B5–B7**.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose)
- Node 20+, yarn
- Built workspace: `yarn build`

## 1. Start infrastructure

```bash
yarn hatchet:poc:up
```

Services:

| Service | URL / port |
|---|---|
| Hatchet dashboard | http://localhost:8080 (default `admin@example.com` / `Admin123!!`) |
| Hatchet gRPC engine | `localhost:7077` |
| callAgent Postgres | `postgres://callagent:callagent@localhost:5433/callagent` |
| NATS JetStream | `nats://localhost:4222` |

## 2. Migrate callAgent DB

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5433/callagent
cd packages/memory-sql && yarn db:migrate && yarn db:generate
```

## 3. Create Hatchet API token

In the dashboard: **Settings → API Tokens → Create API Token**.

```bash
export HATCHET_CLIENT_TOKEN="<token>"
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
```

## 4. Run worker + API host (separate terminals)

**Worker** (dispatches `aplret.outbox.dispatch`):

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5433/callagent
export NATS_URL=nats://localhost:4222
export HATCHET_CLIENT_TOKEN=...
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
yarn workspace @a2arium/hatchet-worker dev
```

**Runtime host** (enqueues outbox rows + triggers Hatchet):

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5433/callagent
export NATS_URL=nats://localhost:4222
export CALLAGENT_OUTBOX_DISPATCHER=hatchet
export HATCHET_CLIENT_TOKEN=...
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
yarn workspace @a2arium/runtime-host dev
```

## 5. Scenario 1 validation

1. Start a demo task via runtime-host RPC.
2. Confirm an outbox row is created in `outbox` and a Hatchet run for `aplret.outbox.dispatch` appears.
3. Confirm the row is deleted after successful dispatch.
4. Confirm `driver_runs` has a row linking `provider_run_id` to `task_id`.

### B5 — metadata search

Filter Hatchet runs by `tenantTaskKey` or `traceId` in the dashboard metadata filter.

### B6 — replay

Stop the worker or break `NATS_URL`, enqueue another outbox event, verify the run fails in Hatchet UI, fix env, **Replay** from the dashboard, verify exactly one downstream delivery.

### B7 — self-hosted UI

Hatchet dashboard at http://localhost:8080 shows runs, errors, retries, and logs.

## Rollback

Set `CALLAGENT_OUTBOX_DISPATCHER=poll` (or unset) to use the in-process `OutboxPublisher` poller again.

## Operational notes

- **Metadata (B5):** Hatchet runs carry `tenantTaskKey`, `tenantTraceKey` (when
  `traceparent` or `traceId` is in the outbox payload), `taskTokenKey` (for
  `task.input_required`), and `agentId` when present in the payload.
- **Poison rows:** When Hatchet exhausts retries, the worker dead-letters the
  outbox row and deletes it (same path as the poll dispatcher DLQ).
- **Trigger fallback:** If `runNoWait` fails (Hatchet unreachable), the API host
  delivers the row inline via the shared bus so enqueue does not orphan rows.
- **Duplicate delivery:** Publish-then-delete is not fully idempotent across
  Hatchet redelivery until ADR 0009 per-effect keys land in Phase 2. CloudEvent
  `id` is the outbox row id for downstream dedupe where supported.
