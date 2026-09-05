# Workspaces and Local Runtime

CallAgent runs one shared runtime while loading agents from multiple external
agent projects. A CallAgent workspace owns the composition registry and `.env`.

Durable Operator progress is enabled by default with the SQL session store. Set
`CALLAGENT_RUN_PROGRESS=disabled` to suppress it; any other value is invalid.
Apply database migrations before use. Progress survives restart, is fenced to the
current turn owner, and is preserved as the last report after terminality.

## Workspace Registry

Create a workspace and add agent projects:

```bash
callagent create workspace content-team
cd content-team
callagent workspace add-agent-source ../../agents/content-agents
```

Then edit `.callagent/workspaces.json`:

```json
{
  "workspaces": [
    {
      "name": "itupdated",
      "root": "/Users/maximantonov/Work/_lab/itupdated",
      "agentIndex": ".callagent/agent-paths.json",
      "envFile": ".env"
    }
  ]
}
```

Fields:

- `name`: Human-readable workspace name used in startup logs.
- `root`: Absolute path, or path relative to the registry file directory.
- `agentIndex`: Path to the workspace agent index, relative to `root`. Defaults to `.callagent/agent-paths.json`.
- `envFile`: Path to the workspace env file, relative to `root`. Defaults to `.env`.

`callagent start` resolves the registry once, then gives its immutable descriptor
to both the runtime host and Hatchet worker. They therefore load the exact same
agents and never reread workspace `.env` files.

## Environment Loading

Inherited process environment is first, then the CallAgent workspace `.env`,
then agent-source `.env` files in registry order.

Env merge policy is first-wins:

- If a key does not exist in `process.env`, the workspace value is applied.
- If a key already exists, the existing value is kept and a warning is logged.
- This keeps shared runtime settings like `MEMORY_DATABASE_URL`, Hatchet, and
  NATS controlled by the callagent root `.env`.

This is a merged env model, not strict per-agent isolation. True isolation would
require separate worker processes per workspace or agents reading config from a
runtime context instead of `process.env`.

## Restart Required

Workspace changes require restarting both runtime processes. The current loader
does not hot-register or unregister agents.

Restart is required because:

- Agent modules are imported into in-memory registries.
- Env is process-global.
- Hatchet worker registration is startup state.
- Active runs must not be mutated underneath their executing worker.

## Running Locally

The CallAgent workspace owns its local infrastructure. Start the packaged
default Hatchet/NATS profile from the workspace:

```bash
npm run infra:up
```

This starts NATS, Hatchet, and its dashboard. Postgres remains an external
dependency you provide. After setting `MEMORY_DATABASE_URL` in the workspace
`.env`, initialise the CallAgent schema from that same workspace:

```bash
npm run db:setup
```

The default infrastructure definition ships with `@a2arium/callagent-runtime`.
To add or override services for one workspace, keep a Compose file in that
workspace and run `callagent infra up --compose docker-compose.local.yml`.

Then run the workspace runtime:

```bash
npm run start
```

Default `callagent start` starts:

- Hatchet runtime worker.
- Runtime host at `http://127.0.0.1:8790`.
- Observer at `http://127.0.0.1:8790/operator`.

Once both the host and worker confirm the same agent set, the CLI prints a
startup summary with the exact Runtime API, Operator, and configured Hatchet
dashboard URLs. Treat that summary as the source of truth when ports or hosts
have been customised.

Useful mode:

```bash
npm run start -- --no-observer
```

- `--no-observer`: runs only the worker and runtime host.

The command does not start infra. It checks Postgres, NATS, and Hatchet before
starting apps and fails fast if they are not reachable.

## Durable worker readiness and recovery

The runtime host and the Hatchet worker have different health responsibilities:

- `GET /health` means the HTTP host is alive.
- `GET /ready` also requires the Hatchet schedule API and, when
  `CALLAGENT_OUTBOX_DISPATCHER=hatchet`, a fresh registered durable worker for
  this workspace installation.

Each generated workspace has a stable `CALLAGENT_RUNTIME_INSTALLATION_ID`.
Every worker process uses a unique Hatchet worker name and writes a short-lived
health lease after Hatchet reports that exact worker as active, heartbeating,
and registered for all required CallAgent workflows. This prevents a healthy
HTTP process or schedule REST token from masking a dead durable stream.

If the worker loop ends unexpectedly, it stops accepting work and exits with a
non-zero code. Run it under a normal process supervisor (Docker restart policy,
systemd, Kubernetes, and so on); the replacement worker registers with a new
identity and durable work re-enters through the existing generation/fence
rules. Do not try to restart individual action listeners inside a live process.

Worker loss also stops timer and turn-request reconciliation and aborts every
active CallAgent segment owned by that process. The runtime waits at most
`CALLAGENT_WORKER_SHUTDOWN_GRACE_MS` (30 seconds by default) before exiting
non-zero. A callback that ignores its `AbortSignal` is therefore stopped by the
process boundary. Deploy runtime protocol changes through a coordinated worker
replacement; do not leave old and new CallAgent workers active together.

An expired lease keeps the canonical delivery key
`taskId:turn-request:generation`. Recovery preserves the logical turn and
generation while admission allocates a new claim ID and higher fence. Hatchet
event payloads are wake-up hints only; the SQL snapshot CAS remains authoritative.
Repeated stale delivery is safe and cannot create another owner.

CallAgent checks cancellation before its artifact, memory, progress, and
registered-effect mutations. Snapshot commits, progress, and effect registration
also retain durable claim/fence checks. An arbitrary external API call cannot be
rolled back; put such mutations behind registered effects and stable idempotency
keys.

`/ready` returns `503 HATCHET_WORKER_STREAM_UNAVAILABLE` while no fresh lease
exists. `HATCHET_SCHEDULE_API_UNAVAILABLE` remains a separate code for the
schedule REST API. API-only installations with workers managed elsewhere can
set `CALLAGENT_HATCHET_WORKER_READINESS=disabled`.

Provider-reported root failures are reconciled into the durable task snapshot,
semantic run state, final status outbox, and Observer. This reconciliation is
idempotent. A provider failure may correct only an `active_run_timeout` that
was claimed later; it never overwrites a completed task, an operator
cancellation, or an established domain failure.

## Workspace-owned maintenance

Maintenance belongs to the CallAgent workspace, not to an agent project or the
framework checkout. A generated workspace includes a stable
`CALLAGENT_MAINTENANCE_INSTALLATION_ID` and two commands:

```bash
npm run maintenance:status # read-only cache and retention candidates
npm run maintenance:run    # immediate maintenance using the same lease as Hatchet
```

On startup, the designated owner workspace reconciles two durable Hatchet cron
workflows: expiry cleanup hourly (`17 * * * *`) and retention review daily
(`23 3 * * *`). Expiry cleanup deletes only rows in
`agent_result_cache` whose TTL has passed, scoped to
`CALLAGENT_MAINTENANCE_TENANT_ID`; this includes the current 30-day artifact
records because artifacts still share that table.

Only one workspace may own maintenance for a shared Hatchet tenant and database
policy. Keep `CALLAGENT_MAINTENANCE_OWNER=true` only there; set it to `false`
in every other workspace. Both scheduled and manual runs use the same durable
database lease, so concurrent work is skipped safely.

Debug retention is report-only by default. Set `CALLAGENT_RETENTION_APPLY=true`
only when you intentionally want eligible debug records deleted. Semantic
summaries, audits, semantic memory, NATS retention, and Hatchet history are not
part of this maintenance subsystem.

## Back Compatibility

If `.callagent/workspaces.json` is missing and `CALLAGENT_AGENT_INDEX` is set,
the runtime treats that index as a single implicit workspace. This preserves the
previous one-index development flow while new setups should use workspaces.
