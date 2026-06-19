# Workspaces and Local Runtime

Callagent can run one shared runtime while loading agents from multiple external
folders. Each external folder can have many agents and its own `.env` file.

## Workspace Registry

The runtime project owns the workspace registry. In local development, copy:

```bash
cp .callagent/workspaces.example.json .callagent/workspaces.json
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

Both `runtime-host` and `hatchet-worker` read the same registry on startup. That
keeps the API process and worker process aligned: the host can enqueue tasks for
the same agents that the worker can execute.

## Environment Loading

The root callagent `.env` is loaded first by the runtime apps. Then each
workspace env file is merged before that workspace's agents are imported.

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

Start infra separately:

```bash
yarn hatchet:poc:up
```

Then run the local runtime apps:

```bash
yarn runtime
```

Default `yarn runtime` starts:

- Hatchet runtime worker.
- Runtime host at `http://127.0.0.1:8790`.
- Operator dashboard Vite dev server at `http://127.0.0.1:8791`.

Useful modes:

```bash
yarn runtime --prod
yarn runtime --no-dashboard
```

- `--prod`: builds `operator-viewer` and serves it from runtime-host at `/operator`.
- `--no-dashboard`: runs only the worker and runtime-host.

The command does not start infra. It checks Postgres, NATS, and Hatchet before
starting apps and fails fast if they are not reachable.

## Back Compatibility

If `.callagent/workspaces.json` is missing and `CALLAGENT_AGENT_INDEX` is set,
the runtime treats that index as a single implicit workspace. This preserves the
previous one-index development flow while new setups should use workspaces.
