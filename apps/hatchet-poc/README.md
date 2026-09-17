# Hatchet POC — Scenario 1 (outbox dispatch)

Self-hosted Hatchet + NATS for manual gates **B5–B7**. **Postgres stays on your host**
(two databases: `callagent` + `hatchet`). Docker only runs Hatchet, RabbitMQ (Hatchet
internal queue), and NATS (callAgent event bus).

## Prerequisites

- **Host Postgres** already running (e.g. `localhost:5432`) — not in Docker
- Docker Desktop (or Docker Engine + Compose)
- Node 20+, yarn
- Built workspace: `yarn build`

## 1. Create databases on host Postgres

One Postgres **server**, two **databases**:

| Database | Used by | Typical URL |
|---|---|---|
| `callagent` | runtime-host, hatchet-worker (`MEMORY_DATABASE_URL`) | `postgres://callagent:callagent@localhost:5432/callagent` |
| `hatchet` | Hatchet engine/dashboard (Docker → host) | `postgres://hatchet:hatchet@localhost:5432/hatchet` |

Example (adjust passwords to match your setup):

```bash
psql -U postgres -f apps/hatchet-poc/scripts/init-host-databases.sql
```

If you already have a `callagent` database from normal development, skip that part and
only create `hatchet`.

Add the Hatchet Docker database URL to the repo-root `.env` (only needed if
credentials/host differ from default):

```bash
HATCHET_DATABASE_URL=postgres://hatchet:hatchet@host.docker.internal:5432/hatchet?sslmode=disable
```

## 2. Migrate callAgent schema

Use your **existing** host connection (same as day-to-day dev):

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5432/callagent
cd packages/memory-sql && yarn db:migrate && yarn db:generate
```

## 3. Start Docker services (Hatchet + NATS)

```bash
yarn hatchet:poc:up
```

Lifecycle commands are bounded so an unhealthy Docker daemon cannot leave the
terminal hanging:

```bash
yarn hatchet:poc:down
yarn hatchet:poc:restart
```

`down` first asks Compose to stop containers gracefully. If the command exceeds
its deadline, it terminates the stuck Compose client, sends `SIGKILL` to the POC
containers, and runs zero-grace cleanup. Named volumes are preserved.

The deadlines can be adjusted when debugging slow machines:

```bash
HATCHET_POC_UP_TIMEOUT_SECONDS=120
HATCHET_POC_DOWN_TIMEOUT_SECONDS=30
HATCHET_POC_STOP_GRACE_SECONDS=10
HATCHET_POC_HARD_TIMEOUT_SECONDS=15
```

If both graceful and forced cleanup time out, check `docker info` and available
host disk space. Compose cannot stop containers while the Docker Engine itself
is unresponsive.

For acceptance testing, do not reuse a development Hatchet history. Create a
fresh Hatchet database and launch a separate Compose project with the isolated
port/volume profile:

```bash
export HATCHET_DATABASE_URL=postgres://hatchet:hatchet@host.docker.internal:5432/hatchet_acceptance?sslmode=disable
docker compose \
  -p callagent-hatchet-acceptance \
  -f apps/hatchet-poc/docker-compose.yml \
  -f apps/hatchet-poc/docker-compose.acceptance.yml \
  up -d
```

This profile uses dashboard `18080`, engine `17077`, NATS `14222`, and its own
project-scoped volumes. It does not stop, migrate, or delete the normal POC
stack. Generate a token from the acceptance project's config volume and set
`HATCHET_CLIENT_HOST_PORT=localhost:17077` before running real-engine tests.

This does **not** start Postgres. Docker runs:

| Service | Purpose | URL / port |
|---|---|---|
| Hatchet dashboard | Operator UI (B5–B7) | http://localhost:8080 (`admin@example.com` / `Admin123!!`) |
| Hatchet gRPC engine | Task scheduling | `localhost:7077` |
| NATS JetStream | **callAgent** cross-process event bus (ADR 0007) | `nats://localhost:4222` |
| RabbitMQ | **Hatchet internal** worker queue (not callAgent) | `localhost:5673` (mgmt `15673`) |

**NATS vs RabbitMQ:** NATS is what you configure on runtime-host / hatchet-worker
(`NATS_URL`). RabbitMQ is Hatchet plumbing between engine and worker containers;
callAgent never connects to it.

Hatchet containers reach host Postgres via `host.docker.internal` (Linux: `host-gateway`
is set in compose).

## 4. Create Hatchet API token

In the dashboard: **Settings → API Tokens → Create API Token**.

```bash
export HATCHET_CLIENT_TOKEN="<token>"
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
```

## 5. Run worker + API host (host processes)

**Worker** (dispatches `aplret.outbox.dispatch`):

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5432/callagent
export NATS_URL=nats://localhost:4222
export HATCHET_CLIENT_TOKEN=...
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
yarn workspace @a2arium/hatchet-worker dev
```

**Runtime host** (enqueues outbox rows + triggers Hatchet):

```bash
export MEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5432/callagent
export NATS_URL=nats://localhost:4222
export CALLAGENT_OUTBOX_DISPATCHER=hatchet
export DISABLE_OUTBOX_PUBLISHER=1
export HATCHET_CLIENT_TOKEN=...
export HATCHET_CLIENT_HOST_PORT=localhost:7077
export HATCHET_CLIENT_TLS_STRATEGY=none
yarn workspace @a2arium/runtime-host dev
```

Replace `MEMORY_DATABASE_URL` with whatever you already use for local development.

## 6. Scenario 1 validation

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
- **V1 SDK imports:** `@a2arium/callagent-driver-hatchet` imports Hatchet from
  `@hatchet-dev/typescript-sdk/v1`; the old V0 deprecation warning should not
  appear.
- **Hatchet diagnostics:** Set `DISABLE_OUTBOX_PUBLISHER=1` on runtime-host while
  validating this POC so the in-process poller does not mask Hatchet dispatch.

## Troubleshooting

- **Hatchet migration fails:** ensure host Postgres is up and `hatchet` DB exists;
  check `HATCHET_DATABASE_URL` in the repo-root `.env`.
- **Linux:** if `host.docker.internal` fails, set
  `HATCHET_DATABASE_URL=postgres://hatchet:hatchet@172.17.0.1:5432/hatchet` (or your
  host LAN IP) in the repo-root `.env`.
- **Reuse existing callagent DB:** no separate Docker DB; `MEMORY_DATABASE_URL` is
  always your host Postgres.
