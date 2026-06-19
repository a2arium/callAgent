# Phase 2 Parent Agent Flow

Purpose: validate the operator-facing AgentRun DAG with a real parent -> child edge.

Flow:

1. User starts `phase2-parent-agent` with text.
2. Parent delegates to `phase2-loop-agent` using `ctx.sendTaskToAgent`.
3. Runtime records child started/completed events.
4. Parent replies with a compact child result summary and completes.

Expected operator graph:

- root `AgentRun`: `phase2-parent-agent`
- child `AgentRun`: `phase2-loop-agent`
- one `AgentRunEdge` with token, child task id, status, and result preview
- turns/effects available as debug details

Build note:

`dist/` is generated and ignored by git, matching the other example agents. Run
`yarn workspace @a2arium/phase2-parent-agent build` before using built `start`
commands for `runtime-host` or `hatchet-worker`.
