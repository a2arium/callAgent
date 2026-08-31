# CallAgent CLI reference

`callagent` is the CLI for creating agents and running a CallAgent workspace.
Pin it in each CallAgent workspace with `@a2arium/callagent-cli`; a global
install is only a convenience and delegates to the local CLI when present.

```text
callagent create agent <name> [--project DIR] [--output DIR] [--preset minimal|non-trivial]
callagent create agent-project <name> [--output DIR] [--with-agent NAME]
callagent create workspace <name> [--output DIR] [--agent-source DIR]
callagent workspace add-agent-source <DIR> [--workspaces PATH] [--name NAME]
callagent workspace remove-agent-source <NAME> [--workspaces PATH]
callagent workspace validate [--workspaces PATH] [--json]
callagent agents list [--workspaces PATH] [--json]
callagent start [--workspaces PATH] [--no-observer]
callagent db setup|migrate|generate
callagent infra up|down|restart [--compose FILE]
callagent maintenance status|run [--json]
callagent local setup|sync|status|unlink|install [--project DIR]
```

Generator names are lowercase kebab-case. Generator output must be a new or
empty directory; the command never overwrites an existing project. `--json`
returns a versioned machine-readable command result where supported. Validation
and `start` return a non-zero exit status for an invalid composition or missing
infrastructure.

When the command is run from a built CallAgent source checkout, it automatically
uses that checkout through a managed, uncommitted `node_modules` overlay. This
also works for output anywhere on disk, while generated `package.json` files
always retain npm semver ranges. Use `--npm` to force published-package mode or
`--callagent-source DIR` to choose a checkout explicitly. `callagent local
status` shows the active mode; `local sync` repairs the overlay after an install.
`create agent-project` also installs its ordinary development tooling
automatically in local-source mode; it infers Yarn from the source checkout's
package manager, or accepts `--package-manager npm|yarn` explicitly.

New workspaces include a complete `.env.example` for local Postgres, NATS,
Hatchet, and Observer. Copy it to `.env`, replace the Hatchet token and Observer
secret, and keep `.env` out of version control.

Run database setup and local infrastructure from the workspace, not from the
CallAgent source repository: `npm run db:setup`, `npm run infra:up`, then
`npm run start`. The default Docker Compose profile is shipped by the runtime;
`--compose FILE` appends a workspace-specific override.
For a local project that uses Yarn, install its non-CallAgent tooling with
`callagent local install --package-manager yarn`; plain `yarn install` cannot
resolve unpublished CallAgent semver versions yet. While those versions remain
unpublished, run package scripts with `npm run build` (or invoke the local bin)
rather than `yarn build`: Yarn resolves the complete manifest before running a
script, whereas npm runs the already-installed local tooling without replacing
the overlay.

See [CallAgent workspaces](./workspaces-and-runtime.md) and
[migration from legacy scaffolding](./migration/callagent-cli-workspace-distribution.md),
follow the [composition tutorial](./tutorial-compose-agent-projects.md), or use
the [generator and workspace operations guide](./generators-and-workspace-operations.md).
