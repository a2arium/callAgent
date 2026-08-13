# Generators and workspace operations

CallAgent separates reusable agent code from the runnable environment. There
are three generators and three corresponding entities.

| Generator | Creates | What it owns |
| --- | --- | --- |
| `callagent create agent` | An agent inside an existing agent project | Agent source, card, runtime manifest, tests, and its index entry |
| `callagent create agent-project` | A reusable agent project | One or more independently built agents and their project dependencies |
| `callagent create workspace` | A CallAgent workspace | Agent-source composition, shared runtime `.env`, database and infrastructure controls, host, worker, and Observer |

## Create and build agent projects

Keep agent projects in any folders you choose. An agent project can have one
agent or several that share code and dependencies.

```bash
callagent create agent-project research-agents \
  --output ~/Work/agents/research-agents \
  --with-agent researcher

cd ~/Work/agents/research-agents
npm run build
```

Add another agent to the same project when appropriate:

```bash
callagent create agent writer --project ~/Work/agents/research-agents
npm run build --prefix ~/Work/agents/research-agents
```

Build agent projects after every source change. The workspace loads their
compiled `dist` modules; it does not compile them and has no workspace build
step of its own.

## Create and operate a workspace

Create a workspace by selecting built agent projects:

```bash
callagent create workspace content-team \
  --output ~/Work/workspaces/content-team \
  --agent-source ~/Work/agents/research-agents
```

The generated workspace owns the operational commands:

```bash
cd ~/Work/workspaces/content-team
cp .env.example .env
# Edit .env: database URL and Observer secret.

npm run db:setup       # Apply CallAgent database migrations and generate Prisma client.
npm run infra:up       # Start the packaged local Hatchet + NATS Docker profile.
```

Then open the configured `HATCHET_DASHBOARD_URL` (default
`http://localhost:8080`), sign in, and create an API token under **Settings →
API Tokens**. Put that value in `HATCHET_CLIENT_TOKEN` in the workspace `.env`.
Each `infra:up` profile has its own Hatchet state: a token from a different
workspace or a previously removed stack will be rejected.

```bash
npm run validate       # Check every selected agent project is built and compatible.
npm run start          # Start runtime host + Hatchet worker + Observer.
```

`npm run start` starts the runtime only after its Postgres, NATS, and Hatchet
preflight succeeds. It starts the runtime host at `http://127.0.0.1:8790`, the
Hatchet worker, and Observer at `http://127.0.0.1:8790/operator`. Use
`npm run start -- --no-observer` to run host and worker without Observer.

Postgres is intentionally not started by `infra:up`: it is a workspace-owned
external dependency configured through `MEMORY_DATABASE_URL`. The workspace
database commands always use that same `.env` value.

Stop or restart the local Docker services with `npm run infra:down` and
`npm run infra:restart`.

## Override local Docker infrastructure

The default Docker Compose profile is version-matched and shipped with
`@a2arium/callagent-runtime`. A workspace can append its own Compose file—for
example to add a local Postgres container, change ports, or add supporting
services:

```bash
callagent infra up --compose docker-compose.local.yml
```

Keep secrets in `.env`, not in the Compose override. `--compose` adds the
workspace file after CallAgent's default profile, so compatible service fields
can override defaults. Use the same option with `down` and `restart`.

For the common dashboard-port collision, no override file is necessary: set
`HATCHET_DASHBOARD_PORT` and the matching `HATCHET_DASHBOARD_URL` in the
workspace `.env`, for example `18081` and `http://127.0.0.1:18081`.

## Local-source versus npm mode

The generated `package.json` is always publishable and contains ordinary npm
semver ranges. The runtime mode is separate:

- **npm mode:** a normal installed CLI resolves published CallAgent packages.
  Use it once the selected versions have been published.
- **Local-source mode:** running the CLI from a built CallAgent checkout
  automatically manages private `node_modules` links to that checkout for the
  workspace and selected agent projects. This allows testing unpublished
  framework changes at arbitrary paths without changing committed manifests.

Use `callagent local status` to inspect the mode, `callagent local sync` after
a package-manager install, `--npm` to force published-package mode, and
`--callagent-source PATH` to choose a checkout explicitly. In local-source mode
for this Yarn-based checkout, use `npm run build`/`npm run start`; Yarn resolves
the unpublished semver dependencies before running scripts.

See [CLI reference](./callagent-cli-reference.md) and
[workspaces and runtime](./workspaces-and-runtime.md) for command details.
