# Workspaces and Local Runtime

CallAgent runs one shared runtime while loading agents from multiple external
agent projects. A CallAgent workspace owns the composition registry and `.env`.

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

`callagent dev` resolves the registry once, then gives its immutable descriptor
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

Start infra separately:

```bash
yarn hatchet:poc:up
```

Then run the workspace runtime:

```bash
callagent dev
```

Default `callagent dev` starts:

- Hatchet runtime worker.
- Runtime host at `http://127.0.0.1:8790`.
- Operator dashboard Vite dev server at `http://127.0.0.1:8791`.

Useful mode:

```bash
callagent dev --no-observer
```

- `--no-observer`: runs only the worker and runtime host.

The command does not start infra. It checks Postgres, NATS, and Hatchet before
starting apps and fails fast if they are not reachable.

## Back Compatibility

If `.callagent/workspaces.json` is missing and `CALLAGENT_AGENT_INDEX` is set,
the runtime treats that index as a single implicit workspace. This preserves the
previous one-index development flow while new setups should use workspaces.
