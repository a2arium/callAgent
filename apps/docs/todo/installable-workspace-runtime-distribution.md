# Installable Workspace Runtime Distribution

> **Status:** Proposed implementation specification.
>
> **Decision:** Extract the existing runnable CallAgent environment into
> installable packages before changing agent identity, dependency binding, or
> process-global runtime state.
>
> **Compatibility:** This phase preserves `.callagent/workspaces.json`,
> `.callagent/agent-paths.json`, bare agent IDs, startup-time agent registration,
> and the current first-wins environment merge policy. The new behavior is
> additive: a project outside this repository can install and run CallAgent.

## Problem Statement

CallAgent is published as framework packages, but the complete development
runtime is still assembled inside this monorepo:

- `scripts/runtime.mjs` supervises the processes by invoking Yarn workspaces.
- `apps/examples/runtime-host` owns the HTTP runtime and mounts Observer.
- `apps/hatchet-worker` owns the Hatchet worker entry point.
- `apps/operator-viewer` and `packages/operator-auth` are private workspace
  packages.
- both host and worker manually register example agents before loading external
  workspaces.

As a result, an application can keep agents in external folders, but it still
needs a CallAgent source checkout to run the same host, worker, and Observer
experience. The framework repository is acting as both a library and the user's
runtime application.

The first extraction must make this everyday workflow possible:

```bash
cd ~/Work/workspaces/content-team
yarn install
yarn callagent dev
```

The command must load agents from independent folders, start the installed
runtime host and worker, expose Observer, and allow those agents to call one
another through their existing agent IDs.

## Goals

1. Run the complete local CallAgent environment from a consuming project that
   does not live inside the CallAgent monorepo.
2. Keep reusable agents in independent folders or packages and compose selected
   agents through the existing workspace registry.
3. Publish a supported runtime API and executable process entry points instead
   of requiring consumers to copy the example host or worker.
4. Provide one `callagent` CLI for validation, development startup, agent
   inspection, and coordinated shutdown.
5. Make host and worker consume the same normalized workspace description and
   fail startup when their agent sets disagree.
6. Reject duplicate agent IDs, malformed manifests, missing builds, and stale or
   inconsistent indexes before accepting tasks.
7. Package Observer and its authentication support with the runtime so agent
   projects do not need to build or import the UI.
8. Prove the published artifacts in a clean project outside the Yarn monorepo,
   including a real agent-A-to-agent-B call across the host/worker boundary.
9. Preserve existing in-repository development commands while they migrate to
   the same published runtime implementation.
10. Resolve the CallAgent workspace and agent-source environment exactly once
    and give the runtime host and Hatchet worker the same environment snapshot.
11. Provide reliable generators for agents, agent projects, and CallAgent
    workspaces, with explicit containment and ownership rules.

## Non-Goals

This phase deliberately does **not** add:

- a typed `callagent.workspace.ts` format;
- workspace-qualified agent IDs such as `content-team/researcher`;
- workspace-local aliases or declarative dependency bindings;
- a checked-in agent-resolution lockfile;
- Git URL agent sources or an agent package registry;
- hot registration, hot unloading, or mutation of active workers;
- multiple isolated CallAgent runtime instances in one Node.js process;
- removal of the global agent, handler, discovery, or environment state;
- per-agent environment isolation;
- automatic building or package-manager installation of arbitrary agent folders;
- automatic startup of production infrastructure;
- a container-image distribution.

These remain valid follow-up directions. They must not be pulled into this
extraction unless a separate specification changes the phase boundary.

## Existing Capabilities to Reuse

The extraction must reuse the current implementation rather than build a second
runtime beside it:

| Existing capability | Current owner | Use in this phase |
|---|---|---|
| Composition root | `packages/core/src/runtime/bootstrapCompositionRoot.ts` | Runtime host and worker bootstrap |
| Runtime and operator routers | `packages/core/src/api/router.ts` | HTTP API and Observer API |
| Workspace registry loading | `packages/core/src/plugin/WorkspaceLoader.ts` | Compatibility loader after validation |
| Agent index loading | `packages/core/src/plugin/AgentIndexLoader.ts` | Load compiled agent modules |
| Agent-to-agent dispatch | `TaskContext.sendTaskToAgent` | Cross-folder agent calls by existing ID |
| Hatchet runtime worker | `packages/driver-hatchet` | Worker implementation |
| Runtime process supervisor | `scripts/runtime.mjs` | Starting point for the new CLI supervisor |
| Runtime environment helpers | `scripts/runtime-env.mjs` | Path resolution and default environment |
| Observer UI | `apps/operator-viewer` | Built static assets distributed with runtime |
| Observer authentication | `packages/operator-auth` | Publishable runtime dependency |
| Package checks | `scripts/check-publish-manifests.mjs`, `scripts/check-packlists.mjs` | Release validation extended to new artifacts |

The example-only registrations in `apps/examples/runtime-host` and
`apps/hatchet-worker` are not part of the extracted runtime. Example agents may
be selected through a workspace registry in repository development, but the
published runtime must not depend on them.

## User Model

### Canonical vocabulary

Use these terms consistently in code, documentation, CLI output, and package
descriptions:

| Term | Meaning | Example |
|---|---|---|
| **CallAgent** | The framework and installable runtime distribution: core APIs, runtime host, drivers, CLI, and Observer. | `@a2arium/callagent-core`, `callagent dev` |
| **Agent** | One runtime-addressable agent implementation with one canonical agent ID, card, and runtime manifest. An agent is a runtime entity, not necessarily a repository or folder. | `researcher-agent` |
| **Agent project** | An independently developed and buildable folder or package containing one or more agent implementations, cards, manifests, and an agent index. A project commonly contains one agent, but the format does not require that. | `~/Work/agents/researcher-agent/` |
| **Agent source** | One agent-project root selected by a workspace registry entry. This is the runtime-loading term, especially when one source exposes several agents. | A `root` entry in `.callagent/workspaces.json` |
| **Agent catalog** | Informal name for all reusable agent projects available to a developer or organization. It is not a new manifest or runtime object in this phase. | `~/Work/agents/` or a set of published agent packages |
| **Agent composition** | The exact selected set of agents intended to work together. It is the logical result of resolving a workspace registry. | Coordinator + researcher + writer |
| **CallAgent workspace** | The runnable composition project. This folder installs CallAgent, owns `.env` and `.callagent/workspaces.json`, selects agent sources, and is where operators run `callagent dev`. | `~/Work/workspaces/content-team/` |
| **Workspace registry** | The compatibility JSON file that declares which agent sources belong to a CallAgent workspace. | `.callagent/workspaces.json` |
| **Runtime stack** | The cooperating processes and services launched for a workspace: runtime host, Hatchet worker, Observer, and their configured adapters. | Output of `callagent dev` |
| **Runtime instance** | One running runtime stack for one resolved workspace and environment snapshot. | A particular `content-team` development run |

Avoid using bare **project** when the distinction matters. Say **agent project**
for reusable agent code and **CallAgent workspace** for the runnable composition
folder. Avoid calling the framework repository “the workspace”; it is the
CallAgent source repository.

The existing registry field is named `workspaces` for compatibility even though
each entry is more precisely an **agent source**. New prose and internal types
should prefer `agent source`; renaming the public JSON field is outside this
phase.

CallAgent has three separate ownership layers:

```text
CallAgent repository                 Independent agent projects
(framework and distribution)        (reusable components)
        │                                     │
        │ published packages                  │ compiled modules + manifests
        └──────────────────┐       ┌───────────┘
                           ▼       ▼
                    CallAgent workspace
                    (composition/deployment unit)
                           │
                           ▼
                    callagent dev
              host + worker + Observer
```

An agent project owns agent behavior and tests. A CallAgent workspace owns the
agent composition and infrastructure configuration. The CallAgent repository
owns the framework and runnable distribution.

### Example filesystem layout

```text
~/Work/
├── callagent/                         # Optional framework source checkout
├── agents/
│   ├── coordinator-agent/
│   │   ├── package.json
│   │   ├── agent-card.json
│   │   ├── agent-runtime.json
│   │   ├── src/
│   │   ├── dist/
│   │   └── .callagent/agent-paths.json
│   ├── researcher-agent/
│   │   └── ...
│   └── writer-agent/
│       └── ...
└── workspaces/
    ├── content-team/
    │   ├── package.json
    │   ├── .env
    │   └── .callagent/workspaces.json
    └── market-analysis/
        ├── package.json
        ├── .env
        └── .callagent/workspaces.json
```

The same `researcher-agent` folder may appear in both composition registries.
It is not copied into either project.

## Package and Artifact Ownership

### `@a2arium/callagent-runtime`

Create a publishable runtime package. It owns:

- the reusable runtime composition API;
- the HTTP host process entry point;
- the Hatchet worker process entry point;
- runtime environment loading and validation hooks;
- coordinated shutdown contracts;
- Observer static assets or a deterministic way to locate the version-matched
  assets installed with the runtime;
- integration with `@a2arium/callagent-operator-auth`;
- health information including the resolved workspace fingerprint.

Proposed public API:

```ts
export type CreateCallagentRuntimeOptions = {
    workspaceDescriptorPath: string;
    mode: 'host' | 'worker';
};

export type CallagentRuntime = {
    workspaceFingerprint: string;
    start(): Promise<void>;
    stop(): Promise<void>;
};

export function createCallagentRuntime(
    options: CreateCallagentRuntimeOptions
): Promise<CallagentRuntime>;
```

The exact internal composition may retain separate host and worker builders,
but both public process entry points must use the same descriptor parser,
validation rules, agent registration callback, and lifecycle primitives.

The runtime package must not depend on example-agent packages.

### `@a2arium/callagent-cli`

Create a small publishable CLI package with this binary:

```json
{
  "bin": {
    "callagent": "./dist/cli.js"
  }
}
```

It owns:

- command parsing and help output;
- `create agent`, `create agent-project`, and `create workspace` orchestration;
- orchestration of the runtime package's shared environment resolver;
- registry path resolution relative to the invocation directory;
- static workspace validation and descriptor generation;
- infrastructure preflight checks;
- spawning the installed runtime host and worker entry points;
- optional Observer development serving when explicitly requested;
- child log prefixes, signal propagation, exit-status handling, and cleanup;
- startup summaries intended for humans.

The CLI must locate runtime entry points through installed package exports. It
must not invoke `yarn workspace`, assume a monorepo root, or shell into a
CallAgent source checkout. Environment precedence and merging belong to a
shared runtime resolver rather than CLI-only code, so programmatic launchers
can apply the identical contract.

### CLI installation and version resolution

`@a2arium/callagent-cli` exposes exactly one public binary:

```json
{
  "bin": {
    "callagent": "./dist/cli.js"
  }
}
```

The CLI supports three invocation modes, with different reliability properties:

```text
Project-pinned (canonical)   npm install -D @a2arium/callagent-cli
                             npm exec -- callagent <command>

One-off bootstrap            npm exec --yes --package=@a2arium/callagent-cli@<version> \
                               callagent -- <command>

Global convenience          npm install -g @a2arium/callagent-cli
                             callagent <command>
```

Package-manager equivalents such as `yarn dlx`, `pnpm dlx`, and globally
installed Yarn/pnpm binaries may be documented, but npm commands are the
portable reference contract.

### Development and distribution modes

This phase supports two deliberate modes:

1. **CallAgent repository development.** The monorepo uses Yarn workspaces and
   current local source. Projects generated beneath the CallAgent repository may
   use `workspace:*` ranges so contributors can exercise unreleased framework
   changes together. Those generated projects are repository fixtures, not
   publishable consumer projects.
2. **Consumer and production use.** Projects outside the CallAgent repository
   use ordinary npm semver ranges and install published package versions. They
   must never depend on `workspace:`, `portal:`, `link:`, or `file:` ranges.

The project generator detects repository development automatically and also
allows an explicit `--monorepo` override. The package manifests shipped to npm
always contain normal semver dependency ranges. This preserves fast local work
without weakening the published distribution contract.

`npm pack` installation testing is useful release hardening, but is deferred
from this phase's required implementation and CI gates. Until that gate is
introduced, published-version integration testing—not local tarball installs—is
the consumer validation path.

The reliability rules are:

1. **CallAgent workspaces pin the CLI locally.** Generated `package.json`
   scripts call `callagent`, and the package manager resolves the binary from
   the workspace's local `node_modules/.bin`. Everyday `npm run dev`,
   `yarn dev`, or `pnpm dev` therefore uses the version committed in the lockfile.
2. **Global installation is optional convenience, not workspace authority.** A
   globally installed `callagent` may create a new project or workspace, but
   generated scripts and CI use the locally pinned version afterward.
3. **One-off bootstrapping must be explicitly versioned in reproducible docs and
   CI.** Avoid an unqualified `latest` in committed scripts.
4. **A global CLI delegates when safe.** When invoked inside a project that has
   a different local `@a2arium/callagent-cli`, the global binary must re-exec the
   local binary with the original arguments and environment, guarded against
   recursion. It prints a debug-level version-resolution message, not a warning.
5. **Version mismatch fails when delegation is impossible.** If the selected CLI
   and installed runtime packages are outside their declared compatible ranges,
   startup and generation stop with exact installed/required versions and an
   install command. They must not continue with mixed package contracts.
6. **Generated packages never require a global install.** A clean clone plus
   package-manager install is sufficient for every generated script.

Examples:

```bash
# Optional global convenience for a developer machine
npm install -g @a2arium/callagent-cli
callagent create agent-project content-agents --with-agent researcher

# Reliable one-off creation without global installation
npm exec --yes --package=@a2arium/callagent-cli@0.1.0 \
  callagent -- create workspace content-team

# Reliable everyday operation after generation
cd content-team
npm install
npm run dev
```

Documentation must recommend project-pinned commands for teams and CI. Global
installation may be shown as an optional convenience box, never as a prerequisite.

### `@a2arium/callagent-operator-auth`

Make the existing private package publishable with complete package metadata,
explicit exports, a packlist, non-workspace dependency ranges, and its supported
CLI entry point if owner recovery remains part of the distribution.

### Observer assets

Observer does not require an independently versioned public package in this
phase. Its production build must be copied into the runtime package during the
release build and included in `npm pack`.

The runtime must resolve the asset directory relative to its installed module,
not `process.cwd()` and not the CallAgent repository layout. The host serves the
assets at `/operator` as it does today.

Observer continues to read agents and workspace metadata through operator APIs.
It must not scan external agent folders.

### Hatchet driver and linked packages

Every transitive runtime dependency must be publishable. In particular,
`@a2arium/callagent-driver-hatchet` must receive the same metadata, dependency
range, packlist, and dry-run checks required by the existing public packages.

The release pipeline must publish linked packages in dependency order or use a
release mechanism that guarantees all referenced versions exist. A package is
not considered extracted while its packed manifest contains `workspace:`,
`portal:`, `link:`, or `file:` dependencies.

## CallAgent Workspace Contract

A CallAgent workspace installs the CLI and runtime:

```json
{
  "name": "content-team-workspace",
  "private": true,
  "scripts": {
    "dev": "callagent dev",
    "validate": "callagent workspace validate",
    "agents": "callagent agents list"
  },
  "devDependencies": {
    "@a2arium/callagent-cli": "^0.1.0"
  },
  "dependencies": {
    "@a2arium/callagent-runtime": "^0.1.0"
  }
}
```

The versions above are illustrative and must be replaced with the actual
coordinated release versions.

## Creation and Scaffolding Contract

The CLI must expose one predictable creation namespace for all three main
entities:

```text
callagent create agent <name>
callagent create agent-project <name>
callagent create workspace <name>
```

The command hierarchy follows the three-entity vocabulary:

```text
CallAgent                    installed as packages
├── create agent             runtime-addressable implementation
├── create agent-project     independently buildable agent container
└── create workspace         runnable composition/deployment project
```

Creation uses explicit containment:

```text
CallAgent workspace
    └── selects agent projects
            └── each contains one or more agents
```

The existing `scaffoldAgent()` output combines two operations: it creates a new
buildable package and places the first agent at that package root. Preserve this
as a convenience and compatibility workflow, but implement the new commands as
separate project and agent generators underneath it.

### `callagent create agent`

This is the canonical agent generator. It adds one runtime-addressable agent to
an existing agent project. It does not create a package manager project or a
CallAgent workspace.

```text
Usage: callagent create agent <name> [options]

Options:
  --project <dir>                  Defaults to the nearest agent-project root
  --output <dir>                   Defaults to src/agents/<name> within project
  --preset <minimal|non-trivial>   Defaults to minimal
  --uses-llm
  --uses-tools
  --uses-children
  --uses-plans
  --force
```

Example:

```bash
cd ~/Work/agents/content-agents
callagent create agent researcher --preset non-trivial
callagent create agent writer --preset minimal
```

The default multi-agent project layout is:

```text
content-agents/
├── package.json
├── tsconfig.json
├── src/
│   └── agents/
│       ├── researcher/
│       │   ├── agent-card.json
│       │   ├── agent-runtime.json
│       │   ├── agent.ts
│       │   ├── types.ts
│       │   └── ...
│       └── writer/
│           └── ...
├── tests/
│   └── agents/
│       ├── researcher/
│       └── writer/
└── .callagent/
    └── agent-paths.json
```

The command must:

- find and validate the target agent-project root;
- reject a duplicate canonical agent ID anywhere in that project;
- generate only agent-owned implementation, manifest, and test files;
- update `.callagent/agent-paths.json` atomically and deterministically;
- add only missing project-level dependencies required by the selected preset;
- preserve unrelated package scripts, dependencies, compiler options, agents,
  and user files;
- roll back generated files and manifest/index changes if validation fails;
- verify the generated card, runtime manifest, module path, and index ID agree.

Projects using the legacy flat one-agent layout remain supported. When the
nearest project is legacy-flat, adding a second agent must stop with migration
guidance rather than silently mix flat and `src/agents/` layouts. A dedicated
layout migration can move the existing agent before another is added.

### `callagent create agent-project`

This command creates an independently buildable container for one or more
agents. By default it creates the project shell only. `--with-agent` composes
the project generator with the canonical agent generator.

```text
Usage: callagent create agent-project <name> [options]

Options:
  --output <dir>                   Defaults to ./<name>
  --with-agent <agent-name>        Create the first agent after project setup
  --preset <minimal|non-trivial>   Preset for --with-agent; defaults to minimal
  --uses-llm
  --uses-tools
  --uses-children
  --uses-plans
  --monorepo
  --force
```

Example:

```bash
callagent create agent-project content-agents \
  --with-agent researcher \
  --preset non-trivial \
  --output ~/Work/agents/content-agents
```

It creates a complete independently buildable agent project:

```text
content-agents/
├── package.json
├── tsconfig.json
├── src/
│   └── agents/
│       └── researcher/             # only when --with-agent is supplied
├── tests/
│   └── agents/
│       └── researcher/
└── .callagent/
    └── agent-paths.json
```

An empty project has an empty agent index and is buildable/testable. Runtime
workspace validation may select it only after at least one agent exists.
The exact agent files depend on the preset and capability flags.

After creation, the command prints only executable next steps:

```text
Created agent project: <absolute path>
Created agent: researcher             # omitted without --with-agent

Next:
  cd <path>
  yarn install
  yarn build
  yarn test
```

The project generator owns package metadata, compiler/test configuration,
project scripts, the `src/agents/` and `tests/agents/` containers, and the empty
agent index. The agent generator owns only a selected agent subtree plus its
index entry. This ownership split prevents either generator from overwriting
the other's work.

### `callagent create workspace`

This command creates the runnable composition project from which users start
the runtime stack.

```text
Usage: callagent create workspace <name> [options]

Options:
  --output <dir>              Defaults to ./<name>
  --agent-source <path>       Repeatable; adds an agent-project root
  --package-manager <name>    npm | yarn | pnpm; default is inferred, then npm
  --force
```

Example:

```bash
callagent create workspace content-team \
  --output ~/Work/workspaces/content-team \
  --agent-source ../../agents/coordinator-agent \
  --agent-source ../../agents/researcher-agent \
  --agent-source ../../agents/writer-agent
```

It creates:

```text
content-team/
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── .callagent/
    └── workspaces.json
```

Generated `package.json` scripts use the canonical CLI:

```json
{
  "scripts": {
    "dev": "callagent dev",
    "validate": "callagent workspace validate",
    "agents": "callagent agents list"
  }
}
```

The generator must resolve each `--agent-source` from the invocation directory,
validate it as an agent project, then write the most portable relative path from
the new workspace registry to that source. An explicitly absolute input may be
preserved only when a portable relative path cannot be represented or the user
requests it.

Creating an empty workspace is allowed because composition often happens in a
later step. It writes `{ "workspaces": [] }`, prints that the workspace is not
runnable yet, and points to `callagent workspace add-agent-source`. Runtime
validation and `callagent dev` continue to reject an empty composition.

### `callagent workspace add-agent-source`

Provide a supported mutation command so users do not need to hand-edit JSON for
the common composition workflow:

```text
Usage: callagent workspace add-agent-source <path> [options]

Options:
  --name <name>              Defaults to the agent-project package/folder name
  --workspaces <path>        Defaults to .callagent/workspaces.json
  --env-file <path>          Defaults to .env within the agent source
```

The command validates the source, rejects duplicate workspace names and agent
IDs, writes through a temporary file plus atomic rename, preserves deterministic
registry ordering, and prints the resulting selected agent IDs. It never loads
or executes agent modules merely to edit the registry.

`callagent workspace remove-agent-source <name>` is the symmetric operation and
must also validate the resulting registry before replacing the file. It refuses
to guess when names or paths are ambiguous.

### Naming, overwrite, and automation rules

All creation commands must:

- accept the entity name as the first positional argument;
- use the canonical nouns `agent`, `agent-project`, and `workspace` in commands,
  help, JSON output, errors, and generated documentation;
- support `--json` with versioned, discriminated results for automation;
- print absolute output paths in results while writing portable relative paths
  into generated registries;
- fail when the output directory exists and is non-empty unless `--force` is
  explicitly supplied;
- never delete unrelated existing files under `--force`; overwrite only the
  generator-owned file set and report every overwritten path;
- validate all names before creating directories;
- clean up incomplete new directories after a failed generation when no
  pre-existing user files were present;
- produce deterministic output for the same inputs and CallAgent version;
- include the generating CallAgent version in `--json` output, not as a required
  committed field in user manifests;
- never write credentials; generated `.env.example` contains placeholders only.

### Full scaffold CLI replacement

This phase removes the `callagent-scaffold` binary and the root
`yarn create-agent` script. There is no compatibility alias or deprecation
window. All maintained documentation, examples, package metadata, tests, and
automation must use:

```text
callagent create agent <name>
callagent create agent-project <name> [--with-agent <name>]
callagent create workspace <name>
```

Existing agent projects already generated by the old command continue to build
and run; only the old generator entry points are removed. Add a migration note
mapping old flags to the new commands and explaining that new agent projects use
the nested multi-agent layout.

Do not create independent template implementations in the CLI package. Split or
move the existing scaffold library through a package boundary that supports
project-shell generation and agent-subtree generation. Remove the old CLI
adapter after every repository reference and package `bin` entry is migrated.

### Workspace registry

The existing JSON contract remains authoritative:

```json
{
  "workspaces": [
    {
      "name": "coordinator",
      "root": "../../agents/coordinator-agent",
      "agentIndex": ".callagent/agent-paths.json",
      "envFile": ".env"
    },
    {
      "name": "researcher",
      "root": "../../agents/researcher-agent",
      "agentIndex": ".callagent/agent-paths.json",
      "envFile": ".env"
    },
    {
      "name": "writer",
      "root": "../../agents/writer-agent",
      "agentIndex": ".callagent/agent-paths.json",
      "envFile": ".env"
    }
  ]
}
```

Relative `root` paths remain relative to the directory containing the workspace
registry. `agentIndex` and `envFile` remain relative to that workspace root.
Absolute paths remain supported.

`CALLAGENT_WORKSPACES` and the CLI `--workspaces <path>` override remain
supported. A relative override is resolved from the invoking composition
project, not the installed runtime package.

### Agent communication

Agents continue to use their current manifest/card names:

```ts
await ctx.sendTaskToAgent('researcher-agent', {
    topic: 'CallAgent workspace distribution',
});
```

Agents communicate through the runtime. They must not import another agent's
implementation. Shared request/response types may live in an ordinary shared
package used by both agents.

## Startup Descriptor

Host and worker currently resolve the workspace registry independently. The
new CLI must instead normalize the registry once into an immutable,
run-scoped startup descriptor.

The descriptor is an internal runtime artifact, not the future public workspace
format and not a checked-in lockfile.

```ts
type RuntimeWorkspaceDescriptor = {
    schemaVersion: 1;
    registryPath: string;
    invocationCwd: string;
    workspaces: Array<{
        name: string;
        root: string;
        agentIndexPath: string;
        envFilePath?: string;
        agents: Array<{
            id: string;
            modulePath: string;
            agentCardPath?: string;
            runtimeManifestPath?: string;
        }>;
    }>;
    environment: {
        keys: Array<{
            key: string;
            source: string;
        }>;
        conflicts: Array<{
            key: string;
            keptSource: string;
            ignoredSource: string;
        }>;
    };
    fingerprint: string;
};
```

Requirements:

1. All paths are absolute and normalized before hashing.
2. Agent and workspace arrays use deterministic ordering.
3. The fingerprint covers `schemaVersion`, workspace names, normalized paths,
   agent IDs, and the content digests of indexed compiled entry modules, agent
   cards, runtime manifests, and indexes. It must not contain or hash
   environment values or secrets.
4. The descriptor is written with user-only permissions in a newly created
   temporary run directory.
5. The descriptor contains no environment values, credentials, task input, or
   agent source content. It records environment key names, winning sources, and
   conflicts only so diagnostics remain reproducible without exposing values.
6. The CLI passes the descriptor path and fingerprint as child arguments and
   passes the complete resolved environment snapshot through each child's
   inherited process environment.
7. Host and worker parse and validate the same schema version before importing
   agents.
8. Each child reports its loaded agent IDs and fingerprint after registration.
9. The CLI does not print “Runtime started” until both children report the
   expected fingerprint and exact agent set.
10. Any mismatch stops all children and returns a non-zero exit code.
11. The temporary run directory is removed during normal shutdown. A stale
    descriptor contains no secrets and may be removed by a later cleanup pass.

This descriptor closes the current host/worker drift risk without introducing a
permanent resolution lockfile.

## Startup and Shutdown Flow

```text
callagent dev
    │
    ├── runtime resolver loads inherited process environment
    ├── merge CallAgent workspace .env
    ├── resolve registry from invocation directory
    ├── merge agent-source .env files in registry order
    │     └── warn on conflicts; keep the earlier value
    ├── validate indexes, cards, manifests, IDs and modules
    ├── create immutable startup descriptor + fingerprint
    ├── preflight Postgres, NATS and Hatchet
    │
    ├── spawn runtime host with resolved env ─────┐
    └── spawn Hatchet worker with same env ───────┤
                               │ parse same descriptor
                               │ do not reread .env files
                               │ import same agent modules
                               │ report fingerprint + IDs
                               ▼
                       CLI compares readiness
                               │
                   mismatch ───┴─── match
                      │                 │
              stop all, exit 1   print URLs/status
                                        │
                                     SIGINT
                                        │
                              TERM children, wait
                                        │
                             force kill after timeout
```

If either child exits unexpectedly, the CLI must terminate the remaining
children and exit non-zero. Shutdown must be idempotent and bounded.

## CLI Contract

### `callagent dev`

```text
Usage: callagent dev [options]

Options:
  --workspaces <path>  Workspace registry; defaults to .callagent/workspaces.json
  --no-observer        Start host and worker without serving Observer assets
  --host <host>        Runtime host bind address
  --port <port>        Runtime host port
```

The existing `--prod` distinction should not survive as a confusing public
mode. Installed packages always use compiled runtime code and built Observer
assets. Repository-only watch commands may retain an internal development mode.

`callagent dev` does not start Postgres, NATS, or Hatchet. It checks required
services and returns actionable failures. Infrastructure orchestration may be
added later under an explicit command or profile.

### `callagent workspace validate`

Validates the selected workspace registry without starting runtime services or
importing agent implementation modules where static metadata is sufficient.

It returns zero only when the composition is safe to start. Diagnostics include
the workspace name, agent ID, and relevant path, but never environment values.

Support `--json` with a versioned result schema for CI and editor tooling.

### `callagent agents list`

Lists the statically resolved agent set from the descriptor input. It must show:

- agent ID;
- agent version when present in the card;
- workspace name;
- module path;
- validation state.

This command does not claim that the runtime is running. A future remote mode
may query a live host separately.

### Later commands

`callagent run`, `callagent observer`, automatic watch mode, and infrastructure
management are useful but not required for this phase. Creation commands and
workspace source mutation are required by the Creation and Scaffolding Contract.
The CLI command router should allow later commands without changing the existing
ones.

## Validation Contract

Validation must happen before task endpoints become ready.

### Registry validation

- The registry is valid JSON and has exactly one non-empty `workspaces` array.
- Unknown fields follow an explicit policy. For this phase, reject unknown
  fields to catch misspellings rather than silently ignore them.
- Workspace names are non-empty and unique.
- Workspace roots exist and are directories.
- Agent index and optional environment paths cannot escape policy accidentally;
  explicit absolute paths remain allowed.

### Agent index and module validation

- Every index entry has a non-empty agent ID and module path.
- Module, card, and runtime-manifest paths resolve relative to the index file.
- Runtime module files exist.
- Published runtime mode accepts compiled JavaScript modules. TypeScript source
  entries fail with a build instruction instead of relying on a hidden loader.
- Agent cards and runtime manifests pass their existing schemas.
- The ID in the index, card, runtime manifest, and registered plugin agree.
- Duplicate agent IDs across all selected workspace roots are fatal.
- Duplicate implicit aliases that could make lookup ambiguous are fatal or
  disabled for the composed runtime; they must never resolve by load order.
- A module that registers zero agents, more than one unexpected agent, or a
  different agent ID fails startup.
- A skipped or failed agent is a startup error. The published runtime must not
  continue with a partial agent set.

Current `AgentRegistry.register()` warns and overwrites duplicate names, and
`findByName()` permits fuzzy matching. The extracted runtime cannot rely on
those permissive behaviors. Implementation may introduce a strict composed
runtime mode or make exact registration globally strict after compatibility
tests, but `callagent dev` must provide deterministic exact-ID behavior.

### Dependency validation

- Existing manifest dependency resolution remains supported.
- Every statically declared target must resolve within the selected agent set.
- Dependency cycles follow the existing dependency resolver's error contract.
- Arbitrary `sendTaskToAgent()` targets built at runtime cannot be statically
  proven; missing targets retain the runtime's typed failure behavior.

### Environment validation

The current policy remains:

```text
inherited process environment
              wins over
CallAgent workspace .env
              wins over
agent-source .env files in registry order
```

Requirements:

- The environment resolver is implemented in `@a2arium/callagent-runtime` and
  is used by the CLI and supported programmatic launchers.
- The resolver runs exactly once per runtime instance before child processes
  start.
- The inherited process environment is the initial environment and therefore
  has highest precedence.
- The CallAgent workspace `.env` is merged next.
- Agent-source `.env` files are merged in workspace-registry order.
- Merge behavior is first-wins: a key is applied only if it does not yet exist.
- A repeated key keeps the earlier value and emits a warning naming the key and
  both sources.
- The CLI passes the exact same resolved environment object to both the runtime
  host and Hatchet worker when spawning them.
- Host and worker must not reread the CallAgent workspace or agent-source `.env`
  files after spawn.
- Both processes import agent modules only after receiving the resolved
  environment, so an agent sees the same `process.env` in host and worker.
- Diagnostics never print values.
- Infrastructure keys such as database, Hatchet, NATS, auth, host, and ports
  belong to the CallAgent workspace environment.
- Documentation warns that two agents cannot safely require different values
  for the same key in this phase.
- Production deployments needing conflicting agent-source environments must
  run separate CallAgent workspaces/runtime instances.

## Runtime API and Observer Requirements

The runtime host must expose:

- the existing task RPC surface;
- the existing operator API and auth surface;
- `/operator` when Observer is enabled;
- a liveness endpoint that does not claim agent readiness;
- a readiness endpoint containing the workspace fingerprint and exact loaded
  agent IDs only after registration and dependencies are ready.

Suggested readiness response:

```json
{
  "ok": true,
  "workspaceFingerprint": "sha256:...",
  "agents": ["coordinator-agent", "researcher-agent", "writer-agent"]
}
```

The worker needs an equivalent readiness signal. It may use a local IPC message
to its parent rather than open another public HTTP port. The signal must occur
only after Hatchet worker registration is complete.

Observer's `/agents` view must continue to receive workspace metadata from the
runtime. Filesystem roots are useful locally but may reveal deployment paths;
production operator responses must expose a display-safe workspace identifier
by default and include absolute roots only in an explicitly local/debug view.

## Failure Semantics

| Failure | Required behavior | User-visible result |
|---|---|---|
| Registry missing | Fail validation unless the documented `CALLAGENT_AGENT_INDEX` compatibility fallback is selected | Exact searched path and creation guidance |
| Invalid JSON/schema | Do not spawn children | Field-level diagnostic |
| Missing compiled agent module | Do not spawn children | Agent ID, path, and build guidance |
| Duplicate agent ID or ambiguous alias | Do not spawn children | Both workspace sources |
| Card/manifest/index ID mismatch | Do not spawn children | All conflicting IDs and files |
| Workspace env collision | Keep first value | Warning with key and sources, no value |
| Infrastructure unavailable | Do not spawn children | Service name and endpoint, no credential content |
| Host/worker fingerprint mismatch | Stop all children | Expected and actual fingerprints |
| Agent import registers unexpected set | Child fails readiness; stop all children | Module and expected/actual IDs |
| One child exits during startup | Stop remaining children | Child name and exit reason |
| One child exits while running | Stop remaining children and exit non-zero | Child name and exit reason |
| Observer assets missing | Fail when Observer is enabled; allow `--no-observer` | Packaged asset path and reinstall guidance |
| Observer auth misconfigured in production | Fail closed | Existing typed configuration guidance |
| Signal during startup | Cancel startup and terminate started children | Clean bounded exit |

No failure may leave a host accepting tasks against an agent set that the worker
cannot execute.

## Security Requirements

1. The startup descriptor contains no secret values.
2. Environment values, URLs containing credentials, auth secrets, and agent
   inputs never appear in validation output or startup summaries.
3. Temporary files use user-only permissions and unpredictable directories.
4. The CLI passes child arguments without shell interpolation.
5. Workspace paths are treated as operator-controlled code locations. Loading
   a workspace executes its compiled agent modules; documentation must state
   this trust boundary.
6. Observer retains server-side authentication and authorization. Packaging the
   UI must not create an unauthenticated operator API.
7. Production binds, trusted origins, cookie settings, and auth startup checks
   retain the existing fail-closed policy.
8. Absolute workspace roots are not returned to non-debug Observer clients by
   default.

## Development Workflow

### Work on one agent

```bash
cd ~/Work/agents/researcher-agent
yarn test
yarn build
```

The agent can be built and tested without starting its CallAgent workspace.

### Compose agents

Add or remove workspace entries, then run:

```bash
cd ~/Work/workspaces/content-team
yarn validate
yarn dev
```

Registry, module, or manifest changes require a restart in this phase. The CLI
must state this rather than imply hot reload.

### Share contracts

Agents may depend on a normal shared TypeScript package for request/response
types. They must communicate through `sendTaskToAgent`, conversations, or other
CallAgent runtime capabilities rather than importing one another's agent
implementations.

## Implementation Plan

### Phase 1: Freeze compatibility contracts

1. Add schema-first validation for the existing workspace and agent-index JSON
   formats without changing their accepted path-resolution semantics.
2. Define the runtime startup descriptor, fingerprint algorithm, readiness
   message, and versioning rules.
3. Add strict duplicate-ID, alias-ambiguity, manifest mismatch, and partial-load
   failures.
4. Define versioned result schemas shared by validation and creation commands.
5. Add focused unit tests before moving process entry points.

### Phase 2: Extract shared runtime composition

1. Create `packages/runtime` as `@a2arium/callagent-runtime`.
2. Move host composition out of the example app into reusable runtime code.
3. Move the worker entry point out of `apps/hatchet-worker` into the runtime
   distribution, delegating Hatchet behavior to the driver package.
4. Remove built-in example-agent registrations from production entry points.
5. Make host and worker use the same descriptor reader and agent loader.
6. Keep thin in-repository example wrappers only where they demonstrate public
   API usage.

### Phase 3: Package Observer and auth

1. Make operator auth publishable and add it to manifest and packlist checks.
2. Build Observer assets as part of the runtime distribution build.
3. Resolve assets relative to the installed runtime package.
4. Verify authenticated operator APIs and SPA routing from an installed pack.
5. Keep local Vite development as a repository contributor workflow, not the
   consuming project's default runtime.

### Phase 4: Create the CLI

1. Create `packages/cli` as `@a2arium/callagent-cli`.
2. Port the useful behavior from `scripts/runtime.mjs` without monorepo or Yarn
   workspace assumptions.
3. Split or move the existing scaffold library through a package boundary
   usable by the CLI for project shells and agent subtrees; do not fork its
   templates.
4. Implement `create agent`, `create agent-project`, `create workspace`,
   `workspace add-agent-source`, `workspace remove-agent-source`, `dev`,
   `workspace validate`, and `agents list`.
5. Remove the `callagent-scaffold` package `bin`, root `yarn create-agent`
   script, old CLI tests, and every maintained documentation/example reference;
   add a direct migration mapping instead of aliases.
6. Add descriptor creation, child readiness comparison, log prefixing, and
   bounded shutdown.
7. Make the root `yarn runtime` command delegate to the new CLI so repository
   development exercises the same code users install.

### Phase 5: Distribution and CI

1. Complete metadata, exports, files, bins, engines, and public dependency
   ranges for all runtime packages.
2. Extend publish-manifest and packlist checks to cover runtime, CLI, auth, and
   Hatchet driver packages.
3. Verify published-version manifests have normal semver dependency ranges and
   no local protocols; defer `npm pack` installation testing to release hardening.
4. Add a real host/worker cross-agent acceptance test.
5. Document coordinated versioning and publish order.

### Phase 6: Documentation cutover and migration

1. Rewrite every maintained user-facing entry point listed in the Documentation
   Cutover Matrix below in the same implementation.
2. Replace repository-specific runtime instructions with installed CLI usage in
   `apps/docs/workspaces-and-runtime.md`.
3. Add a tutorial that creates two agent projects with `--with-agent`, creates
   one CallAgent workspace, composes both sources, and runs them together. Add a
   focused how-to for adding a second agent to an existing agent project.
4. Add CLI reference documentation for creation, global/local installation,
   composition, validation, and runtime commands, plus troubleshooting.
5. Add a migration note for users of the removed scaffold commands, root
   `yarn runtime`, and direct example-app commands.
6. Keep contributor-only source-checkout commands in a separate section and
   clearly label them as repository development, not consumer usage.
7. Add automated stale-command and broken-link checks before calling the
   documentation cutover complete.

## Test Plan

### Unit tests

- Registry path resolution from the invocation directory.
- Relative and absolute workspace root resolution.
- Workspace-registry and agent-index schema validation, including unknown fields.
- Duplicate workspace names and agent IDs.
- Alias ambiguity and exact-ID lookup in composed runtime mode.
- Missing modules and TypeScript-only modules in installed mode.
- Card, runtime manifest, index, and registered-plugin ID disagreement.
- Deterministic descriptor ordering and fingerprints.
- Fingerprint changes for index/card/manifest changes but not environment values.
- Descriptor redaction and user-only file permissions.
- Environment first-wins behavior and redacted conflict diagnostics.
- One resolver invocation produces one environment snapshot for both child
  processes; host and worker do not reread environment files.
- Inherited process, CallAgent workspace, and ordered agent-source precedence.
- CLI argument parsing, help, JSON validation output, and exit codes.
- Agent generator golden subtrees for every preset/capability combination,
  including atomic index and package-manifest updates.
- Agent-project shell and `--with-agent` composition golden trees.
- Agent-project generation includes a valid agent index and remains buildable
  outside the CallAgent monorepo with zero, one, and multiple agents.
- Workspace generator golden tree, package-manager variants, empty composition,
  repeatable `--agent-source`, and portable relative paths.
- Add/remove-agent-source atomic writes, deterministic ordering, duplicate
  rejection, ambiguous removal, and rollback after validation failure.
- Repository-wide proof that `callagent-scaffold` and the root
  `yarn create-agent` script no longer exist in package metadata, maintained
  docs, examples, or tests.
- Old-to-new flag mapping examples in the migration documentation.
- Documentation cutover matrix coverage, historical annotation allowlist, stale
  command scan, and Markdown link verification.
- Generator `--force` ownership boundaries and cleanup after partial failure.
- Versioned `--json` results for every creation/mutation command.
- Global-to-local CLI delegation, recursion prevention, argument/environment
  preservation, and incompatible-version failures.
- Generated project scripts work with only local dependencies and no global CLI.
- Signal handling, startup cancellation, child failure, and bounded shutdown.
- Runtime package asset lookup independent of `process.cwd()`.

### Deferred: package-boundary smoke test

This is intentionally deferred to release hardening. It is not a required CI
or acceptance gate for the two-mode workflow in this phase.

For every supported Node.js version in package-readiness CI:

1. Build all publishable packages.
2. Run manifest and packlist checks.
3. `npm pack` the exact package set.
4. Create a temporary project outside the repository.
5. Install only the tarballs and ordinary registry dependencies.
6. Run `callagent --help` and `callagent workspace validate`.
7. Generate one agent project and one CallAgent workspace using only the packed
   CLI, then validate the generated trees.
8. Run the generated workspace scripts with the locally installed binary while
   no global `callagent` is available.
9. Invoke a deliberately different global packed CLI inside the project and
   prove it delegates to the pinned local binary.
10. Import the public runtime API from plain Node.js ESM.
11. Assert no module resolves through the source monorepo or a `workspace:` range.

This test catches missing files, invalid exports, hidden root dependencies, and
repository-relative paths without requiring infrastructure on every Node matrix
job.

### Packed full-boundary acceptance test

Run on the repository's supported integration platform with PostgreSQL, NATS,
and the real Hatchet POC available:

```text
temporary directory
├── project/                         # installs npm pack tarballs
│   ├── package.json
│   ├── .env
│   └── .callagent/workspaces.json
└── agents/
    ├── caller/
    │   ├── agent-card.json
    │   ├── agent-runtime.json
    │   ├── dist/agent.js
    │   └── .callagent/agent-paths.json
    └── responder/
        ├── agent-card.json
        ├── agent-runtime.json
        ├── dist/agent.js
        └── .callagent/agent-paths.json
```

The test must:

1. Install packed CLI, runtime, and transitive CallAgent packages without Yarn
   workspace linking.
2. Validate two agent projects outside the CallAgent workspace.
3. Start the real installed runtime host and Hatchet worker through
   `callagent dev`.
4. Wait for matching host and worker readiness fingerprints.
5. Submit a task to `caller-agent` through the runtime API.
6. Have `caller-agent` invoke `responder-agent` using
   `ctx.sendTaskToAgent('responder-agent', ...)`.
7. Observe the real terminal result through the runtime API.
8. Verify both agents and their display-safe workspace metadata through the
   authenticated or explicitly local-development operator API.
9. Send SIGTERM and prove host and worker exit within the shutdown deadline.
10. Assert no processes, temporary credentials, or descriptor directories are
    left behind.

Mocks alone do not satisfy this gate. Prior CallAgent failures have passed
separate host/producer and segment/consumer tests while the reconstructed real
boundary silently dropped behavior.

### Required failure tests

- Host and worker receive different descriptors.
- Host and worker are spawned with different environment snapshots.
- A CallAgent workspace or agent-source `.env` changes after resolution; the
  running children retain the same resolved snapshot until restart.
- Agent module changes between validation and child import.
- A module registers an ID different from its card.
- Two workspaces contain the same ID.
- One child becomes ready and the other crashes.
- Observer assets are absent from a packed runtime.
- Infrastructure disappears during startup.
- SIGINT arrives before readiness.
- An agent-source environment attempts to override an infrastructure value.
- Production Observer auth is missing or unavailable.

### Regression suites

The implementation must keep these existing surfaces green:

```bash
yarn test
yarn build
yarn workspace @a2arium/callagent-core test:types
yarn verify:publish-manifests
yarn verify:packlists
yarn verify:core-imports
```

Add focused runtime, CLI, auth, Hatchet driver, workspace loader, and Observer
tests as their package scripts become available.

## Performance and Resource Requirements

- Descriptor generation is linear in the number of workspace entries and the
  bytes of indexed entry modules, cards, manifests, and indexes.
- Startup hashes each indexed compiled entry module so a change between
  validation and child import is detectable. It must not recursively hash
  source trees, `node_modules`, or an agent's transitive dependency graph.
- Host and worker import agents once at startup, matching current behavior.
- Validation must bound individual metadata file sizes and registry entry counts
  to avoid accidental memory exhaustion. Initial limits must be documented and
  configurable only within safe bounds.
- Child stdout/stderr forwarding must respect stream backpressure rather than
  buffer unbounded logs in the CLI.
- Readiness has a configurable bounded timeout with an actionable timeout error.
- Shutdown has a bounded graceful interval followed by forced termination.
- Observer assets are served from disk with production cache headers for hashed
  assets and no-cache behavior for the HTML entry point.

## Distribution and Release Gates

Before the feature is marked complete:

1. Every new public package passes `scripts/check-publish-manifests.mjs`.
2. Every new public package is included in `scripts/check-packlists.mjs`.
3. Packed tarballs contain runtime entry points, declarations, CLI bins, and
   Observer assets, and exclude source tests, `.env` files, caches, and local
   descriptors.
4. Package exports work under supported Node.js ESM versions.
5. Published dependency ranges contain no local-only protocols.
6. A documented command produces a complete dry-run release from a clean tree.
7. CI runs the external packed-project smoke test.
8. A required integration or release-candidate job runs the packed full-boundary
   Hatchet acceptance test.
9. Release notes name the compatible versions of core, runtime, CLI, driver,
   memory, event-bus, auth, and Observer assets.

## Migration and Compatibility

### Existing CallAgent repository users

Root `yarn runtime` remains available during migration but delegates to the new
CLI. Existing flags receive either an equivalent mapping or a clear deprecation
message.

The root `yarn create-agent` script and published `callagent-scaffold` binary are
removed rather than delegated. The migration document provides exact new
commands for each former flag combination, and all maintained docs change in the
same implementation.

### Existing external workspace registries

Existing `.callagent/workspaces.json` files and `CALLAGENT_AGENT_INDEX` fallback
continue to load. Configurations that currently rely on duplicate IDs,
ambiguous fuzzy aliases, malformed entries being skipped, or partial startup
must be fixed because the installed runtime fails closed.

This intentional tightening requires a migration note and a validation command
that reports every incompatibility before users switch startup commands.

### Agent authors

Agent runtime modules must be compiled before `callagent dev`. Agent cards,
runtime manifests, and indexes remain in their current formats. Existing
`sendTaskToAgent` code continues to use bare IDs.

### Later identity migration

Qualified IDs and local aliases are deferred. When introduced, they will need a
separate migration across task storage, schedules, conversations, Hatchet
metadata, Observer filters, manifests, and code references. This extraction
must not encode a new permanent identity syntax accidentally.

## Observability and Supportability

Startup logs must include:

- CLI/runtime version;
- registry path;
- workspace names;
- agent IDs and versions;
- workspace fingerprint;
- host, RPC, and Observer URLs;
- infrastructure connectivity state;
- environment conflict keys without values.

Support bundles and normal logs must omit secrets, task payloads, agent source,
and raw environment values.

The health/readiness contract must let an operator distinguish:

- process alive but still loading;
- workspace invalid;
- infrastructure unavailable;
- host ready but worker unavailable;
- complete runtime ready with a matching agent set.

## Documentation Deliverables

Implementation is incomplete without:

1. Updated [workspace runtime documentation](../workspaces-and-runtime.md).
2. A tutorial for generating two independent agent projects, composing them in
   one CallAgent workspace, and running the stack, plus a how-to for adding an
   agent to an existing agent project.
3. CLI reference for all three generators, agent-source mutation, `dev`,
   `workspace validate`, and `agents list`.
4. A package/runtime API reference.
5. Troubleshooting for missing builds, duplicate IDs, env collisions,
   infrastructure failures, and fingerprint mismatches.
6. A migration note covering root `yarn runtime`, direct example-host startup,
   stricter validation, and package installation.
7. Contributor documentation explaining how to develop and release the runtime
   packages from this monorepo.

## Documentation Cutover Matrix

Documentation changes are part of the feature, not post-implementation cleanup.
The code, package manifests, generated templates, and current documentation must
switch to the canonical vocabulary and commands in one release.

### Maintained documents: rewrite

These files are active user or contributor entry points and must be updated:

| File | Required change |
|---|---|
| `README.md` | Introduce the three entities; show local and optional global CLI installation; replace `yarn create-agent`; distinguish framework development from a CallAgent workspace. |
| `packages/core/README.md` | Remove `npx callagent-scaffold`; point generator users to `@a2arium/callagent-cli`; retain only programmatic core APIs actually exported after extraction. |
| `apps/docs/0-aplret_contracts.md` | Replace the old bin/script inventory; document canonical agent, agent-project, and workspace creation commands; update the public scaffold API inventory if ownership or exports move. |
| `apps/docs/1-tutorial_build_your_first_aplret_agent.md` | Rewrite the tutorial around `callagent create agent-project --with-agent`; show project-pinned installation and the resulting nested layout. |
| `apps/docs/2-manifest_spec_agent_card_runtime_manifest.md` | Update root-layout conventions so cards/manifests may live under `src/agents/<agent>/`; define agent-project versus agent ownership. |
| `apps/docs/14-agent_repository_layout_for_aplret.md` | Document zero/one/multi-agent project layouts and `callagent create agent`; remove old root Yarn commands. |
| `apps/docs/workspaces-and-runtime.md` | Make CallAgent workspace the runnable unit; document `create workspace`, source mutation, environment precedence, `callagent dev`, and Observer/Hatchet startup. |
| `apps/examples/runtime-host/README.md` | Reposition as a thin contributor/example wrapper or remove consumer startup guidance once the installed runtime is canonical. |
| `packages/operator-auth/README.md` | Replace repository workspace commands with installed runtime/CLI commands where applicable. |

Search the complete maintained documentation corpus during implementation; this
matrix is a minimum inventory, not permission to ignore another active reference.

### New documents: create

Create or promote these durable docs under `apps/docs/` using the repository's
existing Markdown conventions:

1. **Tutorial:** generate two agent projects, create a CallAgent workspace,
   compose sources, start the runtime stack, and verify a cross-agent call in
   Observer.
2. **How-to:** add or remove an agent in an existing agent project.
3. **How-to:** add or remove an agent source in an existing CallAgent workspace.
4. **Reference:** complete `callagent` command tree, arguments, defaults, exit
   codes, and versioned `--json` schemas.
5. **Explanation:** the three-entity model and why global CLI installation is
   convenience while local pinning is authoritative.
6. **Troubleshooting:** missing builds, duplicate IDs, ambiguous aliases,
   environment conflicts, fingerprint mismatches, infrastructure failures, and
   global/local version resolution.
7. **Migration:** exact old-to-new command mapping and flat-to-nested agent
   project guidance.

### Historical documents: preserve and annotate

Files under `apps/docs/migration/done/`, `apps/docs/todo/done/`, and dated
production-readiness/evidence reports describe what existed at that time. Do not
rewrite historical commands as if the new CLI had existed then.

For historical files that are still likely to be discovered through links or
search:

- retain the original content;
- add a short top-of-file notice stating that the command is historical;
- link to the new migration document and current CLI reference;
- exclude fenced historical examples from the stale-command CI failure using an
  explicit, narrow path allowlist rather than a broad textual exception.

At minimum review and annotate:

- `apps/docs/migration/done/4.1-scaffold-agent-tooling.md`;
- `apps/docs/migration/done/4.2-agent-repo-layout-migration.md`;
- `apps/docs/todo/done/next-phase-better-readability/4.1-flow-md-standard.md`;
- `apps/docs/todo/done/next-phase-better-readability/4.2-agent-repository-layout-and-patterns.md`.

Dated orchestration evidence containing `yarn runtime` may remain unchanged when
it is clearly an immutable record. Current operational runbooks must not link to
those commands as the recommended workflow.

### Canonical old-to-new command mapping

The migration document must include concrete mappings:

```text
OLD
callagent-scaffold --name X --preset P --output DIR [capability flags]

NEW
callagent create agent-project X --with-agent X \
  --preset P --output DIR [capability flags]

OLD
yarn create-agent --name X --preset P --output DIR [capability flags]

NEW
npm exec -- callagent create agent-project X --with-agent X \
  --preset P --output DIR [capability flags]

OLD
yarn runtime [--no-dashboard] [--workspaces PATH]

NEW
npm run dev
# or: npm exec -- callagent dev [--no-observer] [--workspaces PATH]
```

The mapping must explicitly explain renamed flags (`--no-dashboard` to
`--no-observer` when behavior is equivalent), removed flags, and any behavior
that cannot be translated one-for-one.

### Documentation vocabulary gate

All maintained docs and generated README files must use:

- **CallAgent** for the framework/distribution;
- **agent** for one runtime-addressable implementation;
- **agent project** for an independently buildable container;
- **agent source** for a selected project root;
- **CallAgent workspace** for the runnable composition folder;
- **workspace registry** for `.callagent/workspaces.json`;
- **runtime stack** for host + Hatchet worker + Observer;
- **runtime instance** for one running stack.

Bare “workspace” is acceptable in CLI syntax and obvious local context, but
architecture prose must use **CallAgent workspace** when confusion with package
manager workspaces or the CallAgent source repository is possible.

### Documentation verification gates

Add a CI script that fails when removed commands appear in maintained docs,
generated templates, current examples, or package metadata:

```bash
rg -n 'callagent-scaffold|yarn create-agent' \
  README.md packages apps/docs apps/examples package.json
```

The implementation must refine this into an explicit maintained-path scan plus
a narrow historical allowlist. A successful raw search may still return
historical documents and the migration's `OLD` examples; every result must be
classified rather than blindly deleted.

Also verify:

- every new Markdown link resolves;
- every command example passes shell/CLI smoke tests where practical;
- generated file trees match generator golden tests;
- `callagent --help` uses the same vocabulary as the docs;
- local-pinned, one-off, and global installation examples are documented
  against published versions;
- README reaches the tutorial, CLI reference, workspace guide, and migration
  document within two links;
- current docs contain no consumer instruction requiring a CallAgent source
  checkout.

## Acceptance Criteria

1. A clean project outside the CallAgent repository can install published
   CallAgent packages and run `callagent dev`.
2. The published CLI can generate an agent, a zero/one/multi-agent buildable
   agent project, and a valid CallAgent workspace without using CallAgent
   monorepo files or local-only dependency ranges.
3. `callagent workspace add-agent-source` and `remove-agent-source` update the
   registry atomically, reject ambiguous or invalid compositions, and preserve
   portable paths.
4. The old `callagent-scaffold` binary and root `yarn create-agent` script are
   absent, all maintained documentation uses the canonical creation commands,
   and existing generated agent projects remain runnable.
5. The command starts an installed runtime host and Hatchet worker and serves
   the version-matched Observer without invoking a repository Yarn workspace.
6. Independent agent projects are selected through the existing workspace JSON
   registry and are not copied into the CallAgent workspace.
7. An agent in one folder can call an agent in another folder through the real
   host/worker path and return a terminal result.
8. Host and worker report the same fingerprint and exact agent set before the
   runtime becomes ready.
9. Host and worker receive the same environment snapshot resolved once using
   inherited-process, CallAgent-workspace, then registry-order agent-source
   first-wins precedence; neither child rereads `.env` files.
10. Duplicate IDs, ambiguous aliases, malformed manifests, missing builds,
   partial imports, and host/worker mismatches fail startup deterministically.
11. Environment conflicts keep the documented first value, warn without leaking
   values, and do not claim to provide isolation.
12. Observer lists the running agents and workspaces through runtime APIs and
   does not scan agent folders itself.
13. Ctrl-C, SIGTERM, startup failure, and unexpected child exit stop all runtime
   processes within a bounded deadline.
14. Public manifests and tarballs contain no local dependency protocols or
    repository-relative runtime assumptions.
15. Published-version integration and the real full-boundary Hatchet acceptance
    test pass in CI or required release gates. `npm pack` smoke testing is a
    deferred release-hardening enhancement.
16. Existing framework tests, builds, type tests, import checks, manifest checks,
    and packlist checks remain green.
17. Every maintained file in the documentation cutover matrix is updated, new
    tutorial/how-to/reference/explanation/troubleshooting/migration docs ship,
    historical docs are preserved and annotated, and stale-command/link gates
    pass.

## Completion Checklist

- [ ] Compatibility schemas and strict validation are implemented.
- [ ] `create agent`, `create agent-project`, and `--with-agent` reuse shared
      scaffold primitives and generate valid independently buildable projects
      plus deterministic agent indexes.
- [ ] `create workspace` and agent-source mutation commands are implemented and
      use atomic, validated registry writes.
- [ ] Old scaffold CLI/script entry points are removed and all maintained docs,
      examples, package metadata, and tests use canonical creation commands.
- [ ] Documentation cutover matrix, new docs, historical annotations, command
      smoke tests, stale-command scan, and link checks are complete.
- [ ] Global CLI installation is optional; generated projects pin and run the
      local CLI, and global invocation delegates to it when versions differ.
- [ ] Shared environment resolution produces one snapshot for host and worker.
- [ ] Runtime startup descriptor and fingerprint contracts are implemented.
- [ ] `@a2arium/callagent-runtime` is publishable and contains Observer assets.
- [ ] `@a2arium/callagent-cli` is publishable and exposes `callagent`.
- [ ] Operator auth and Hatchet driver are publish-ready.
- [ ] Host and worker use one shared loader and no example-agent dependencies.
- [ ] Root repository runtime delegates to the installed-style CLI path.
- [ ] Published-version host/worker cross-agent acceptance test passes.
- [ ] Failure, signal, security, performance, and regression tests pass.
- [ ] Distribution and coordinated-release gates pass.
- [ ] Required user, migration, API, and contributor docs are updated.

## Deferred Follow-Up Tracks

After this specification is complete and stable, create separate design work for:

1. Instance-owned registries and injected agent configuration.
2. Per-workspace worker-process isolation profiles.
3. Workspace-qualified agent identity and migration of durable records.
4. Workspace-local dependency aliases and typed bindings.
5. A typed composition format and generated resolution lockfile.
6. Package, Git, and remote agent source resolvers.
7. Safe watch/restart behavior for local agent development.
8. `npm pack` temporary-project smoke testing and tarball-boundary validation.

Each track must preserve the installable composition workflow established here
instead of moving application ownership back into the framework repository.
