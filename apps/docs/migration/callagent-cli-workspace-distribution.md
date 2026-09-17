# Migration: legacy scaffolding to CallAgent workspaces

This is the current migration guide. Historical documents retain their original
commands and are not current instructions.

| Before | Now |
|---|---|
| `callagent-scaffold --name X --preset P --output DIR` | `callagent create agent-project X --with-agent X --preset P --output DIR` |
| `yarn create-agent --name X --preset P --output DIR` | `npm exec -- callagent create agent-project X --with-agent X --preset P --output DIR` |
| `yarn runtime [--no-dashboard] [--workspaces PATH]` | `npm run start` or `npm exec -- callagent start [--no-observer] [--workspaces PATH]` |

`callagent-scaffold` and the root `yarn create-agent` command were removed;
there is no compatibility alias. `--no-dashboard` is now `--no-observer`.

Move a legacy flat agent into an **agent project** by creating
`src/agents/<agent-name>/`, moving the module and both manifests there, adding
its compiled paths to `.callagent/agent-paths.json`, then building. Create a
separate **CallAgent workspace** to select one or more agent projects through
`.callagent/workspaces.json`. The workspace owns `.env`, installation, and
`callagent start`; agent projects own code and builds.
