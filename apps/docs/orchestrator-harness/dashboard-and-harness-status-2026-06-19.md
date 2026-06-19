# Orchestrator Harness and Operator Dashboard Status

Last updated: 2026-06-19.

## Executive Summary

The orchestrator harness is now past the pure POC stage. The runtime can execute
APLRET agents through Hatchet-backed parent workflows, persist driver run
metadata, project semantic run graphs, and expose those projections through the
Operator Dashboard.

The Operator Dashboard is no longer only a passive viewer. It now has:

- A fleet view backed by `driver_runs`.
- A run detail view backed by `AgentRunGraph`.
- Turn, LLM, memory, effect, Hatchet, and Opik drill-down surfaces.
- A registered Agents page that can launch agents from the browser.
- Workspace loading so one callagent runtime can load external agent folders
  such as `itupdated`, including their `.env` files.
- A local `yarn runtime` command that starts the runtime host, Hatchet worker,
  and optionally the dashboard dev server.

The main remaining gap is durability/product hardening: normalized graph tables,
operator actions, better task status finalization, auth, and production-grade
workspace/process isolation.

## Current Architecture

The current local development stack has four layers:

1. **Infrastructure**
   - Host Postgres for callagent memory and Hatchet database.
   - Docker Hatchet, RabbitMQ, and NATS via `yarn hatchet:poc:up`.

2. **Runtime processes**
   - `runtime-host` owns HTTP APIs, JSON-RPC, SSE streams, and serves the built
     dashboard at `/operator`.
   - `hatchet-worker` owns durable Hatchet task execution.
   - Both processes load the same workspace registry at startup.

3. **Durable execution model**
   - `agent.<agentId>` or fallback `aplret.task` is the durable parent.
   - `aplret.segment` executes APLRET loop segments to the next durable boundary.
   - `aplret.outbox.dispatch` publishes outbox events and stream/status events.

4. **Operator product model**
   - `driver_runs` is the current bridge between Hatchet execution and product
     views.
   - `wm_events` captures compact cognition and memory operation facts.
   - `AgentRunGraph` projects root/child agents, turns, events, effects, LLM
     calls, and memory operations into one semantic graph.
   - The dashboard consumes these semantic APIs rather than asking users to
     reason directly from Hatchet workflow names.

## What Is Done

### Runtime and Hatchet Harness

Implemented:

- Shared runtime composition root for host and worker.
- Hatchet outbox dispatch integration.
- Hatchet durable task and segment workflows.
- Agent-specific Hatchet workflow names via `agent.<agentId>`.
- `driver_runs` persistence for provider run ids, task ids, operations, status,
  root task ids, turn sequence, boundary kind, and trace references.
- NATS-backed cross-process event path for Hatchet mode.
- `runtime-host` serving the built Operator Dashboard at `/operator`.

Important working behavior:

- Agents launched through runtime-host become visible in dashboard graph APIs.
- External agents can execute through the Hatchet worker when both host and
  worker load the same workspace registry.
- Hatchet still shows infrastructure workflow statuses. The dashboard shows
  product/agent semantic statuses.

### Workspace Loading

Implemented:

- `.callagent/workspaces.json` registry, with committed
  `.callagent/workspaces.example.json`.
- `loadWorkspaces()` in core.
- Per-workspace `.env` merge before importing that workspace's agents.
- First-wins env conflict policy: callagent root `.env` remains authoritative
  for shared runtime variables.
- Fallback support for the older `CALLAGENT_AGENT_INDEX` flow.
- `yarn runtime` app orchestrator.

Current workspace model:

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

Known limitation:

- Env is still process-global. This is acceptable for the local MVP, but true
  per-workspace isolation needs separate worker processes or agents reading
  config from context instead of `process.env`.

### Operator Dashboard

Implemented:

- React/Vite/Tailwind dashboard at `apps/operator-viewer`.
- TanStack Router, Query, Table, and virtualized fleet table.
- React Flow graph with deterministic layout.
- Light/dark theme with localStorage persistence.
- Greyer dashboard palette and improved light-mode contrast.
- Fleet list with filters and URL state.
- Run detail page with graph, selected agent inspector, tabs, turn timeline,
  LLM calls, memory ops, cost summary, and links.
- Internal scrolling for the selected-agent inspector tab content.
- Fleet header/data alignment fixes.
- Dashboard status derivations using run graph data when available.
- Agents page for launching registered agents.

The Agents page now supports:

- Listing registered agents from `GET /agents`.
- Grouping agents by workspace when workspace metadata exists.
- Selecting an agent.
- Per-agent browser-local payload presets.
- Add, rename, delete, and edit JSON payload tabs.
- Live JSON validation.
- Format JSON helper.
- Run through `/rpc` `tasks/send`.
- Navigation to the generated run detail page.

### API Surface

Implemented or updated:

- `GET /agent-runs`
- `GET /tasks/:taskId/run-graph`
- `GET /tasks/:taskId/turns/:turnSeq`
- `GET /tasks/:taskId/memory`
- `GET /agents`
- `POST /rpc` with `tasks/send`
- `POST /rpc` with `tasks/sendSubscribe`
- Server-generated task ids when `params.id` is omitted.

### Semantic Failure Handling

Important learning and fix:

APLRET can canonically finish a turn with:

```json
{
  "kind": "complete",
  "result": {
    "ok": false,
    "error": {
      "code": "NO_URL",
      "message": "No URL provided"
    }
  }
}
```

This means the transport and turn boundary completed, but the agent outcome is
semantically failed.

Implemented:

- New `turn.segment` driver rows are marked `failed` when
  `boundary.kind === "complete"` and `boundary.result.ok === false`.
- `AgentRunGraph` also derives failed status from existing `turn.completed`
  cognition events with `transition.result.ok === false`, so older rows are
  displayed correctly.
- Regression test added in `packages/core/tests/operator.runGraph.test.ts`.

Deliberate behavior:

- Hatchet may still show the workflow as succeeded if the worker function
  returned normally.
- The dashboard shows the agent semantic status as failed.
- This distinction is correct for deterministic business/input failures because
  throwing would cause Hatchet retries for valid terminal agent outcomes.

## What Is Left

### High Priority

- **Root run finalization.** `agent.run` rows can remain `queued` while terminal
  segment rows show the actual result. The dashboard compensates, but the
  persisted root row should eventually be finalized.
- **Normalized graph persistence.** Replace `driver_runs` as the bridge table
  with durable product tables:
  - `agent_runs`
  - `agent_run_edges`
  - `turn_runs`
  - `effect_runs`
- **Semantic status metadata in Hatchet.** Hatchet workflow success and agent
  semantic failure are different. Add metadata such as `semanticStatus=failed`
  and `errorCode=NO_URL` so Hatchet remains useful without forcing retries.
- **Dashboard hardening for large graphs.** Add graph windowing, collapsed
  groups, and server-side failure-path calculation.
- **Workspace validation.** Add a command that validates `.callagent/workspaces.json`,
  confirms agent indexes exist, confirms env files exist, and prints loaded
  agent names before runtime start.

### Medium Priority

- **Payload presets beyond browser memory.** Current payload presets are local to
  the browser. Later we may want workspace-provided examples, import/export, or
  team-shared server-side presets.
- **Agent input schemas.** The dashboard currently only validates JSON syntax.
  Agents need optional input schema metadata before the UI can validate payload
  shape.
- **Auth and tenant boundary.** The UI reserves auth, but real role-based access
  and tenant derivation from session are not implemented.
- **Operator actions.** Cancel, retry, resume, and replay should wait for ADR
  0010 cancellation semantics and safe effect idempotency.
- **Streaming UX in launcher.** The Agents launcher currently uses `tasks/send`.
  A future mode should use `tasks/sendSubscribe` and show live progress/events.
- **Better dev UX for runtime.** `yarn runtime` starts app processes only and
  expects infra to already run. This is intentional, but a future
  `--with-infra` option could run `hatchet:poc:up` and wait for readiness.

### Lower Priority

- Code splitting for dashboard bundles.
- Rich JSON editor dependency for the payload editor.
- Saved dashboard filters/views.
- Workspace hot reload. The current model intentionally requires restart.
- Per-workspace worker isolation for conflicting env values.

## Lessons Learned

### Hatchet Is Infrastructure, Not The Product UI

Hatchet is useful for worker health, replay, retry, and raw execution debugging.
It is not the right primary operator surface for APLRET agent semantics.

Reasons:

- Generic workflows like `aplret.segment` and `aplret.outbox.dispatch` are not
  meaningful to product operators.
- Hatchet status tells us whether workflow code returned or threw.
- Agent status can be semantically failed even when the workflow returned
  normally.
- Product debugging needs root agents, child agents, turns, memory, LLM, and
  decisions in one graph.

Conclusion:

- Hatchet remains an infrastructure debug layer.
- `AgentRunGraph` and the Operator Dashboard are the product debug layer.

### Runtime Host and Worker Must Load The Same Agents

Starting a task through `runtime-host` is not enough. The Hatchet worker also
needs the exact same agent registry, otherwise the worker executes fallback or
generic behavior.

This caused early runs to show repeated `answer_with_llm("Ok.")` behavior
instead of real `fetch-page-router` logic.

Conclusion:

- Workspace registry must be shared by host and worker.
- Agent loading has to happen at process startup.
- Changes require restart for now.

### Workspace Env Is Necessary But Not True Isolation

`itupdated` agents read values like `ZYTE_API_KEY` from `process.env`. Loading
the workspace `.env` fixed the missing-secret problem.

But `process.env` is process-global, so the current solution is a merged env
model.

Conclusion:

- This is good enough for local MVP.
- Production-grade isolation needs separate worker processes per workspace or
  config injection through context.

### Agent IDs Should Be Generated By The Runtime

Manual task ids caused accidental reuse and mixed traces. Server-generated ids
make dashboard testing much safer.

Conclusion:

- `params.id` should be optional for JSON-RPC calls.
- Runtime-generated ids should include the agent id prefix for readability.

### Dashboard Launcher Needs Payload Memory

A hardcoded payload example was useful for the first smoke test but wrong as a
product behavior.

Current improved model:

- Payload presets are local to each browser and keyed by agent id.
- Each agent can have multiple editable payload tabs.
- JSON validation and formatting happen client-side.

Conclusion:

- Browser-local presets are the right MVP.
- Agent-provided schemas/examples should come later.

### Semantic Failures Need A Distinct Mental Model

The important distinction:

- **Runtime/infrastructure failure:** worker threw, DB failed, invariant broke,
  timeout happened. Hatchet should show failed and maybe retry.
- **Agent semantic failure:** agent completed with `ok:false`. Operator
  Dashboard should show failed. Hatchet may still show succeeded because the
  workflow executed correctly.

Conclusion:

- Do not throw on every `ok:false` by default.
- Persist and display semantic status explicitly.
- Add Hatchet metadata for semantic status rather than abusing workflow failure.

## Recommended Next Steps

1. Fix root `agent.run` finalization so `driver_runs` no longer leaves root rows
   as `queued` after terminal segment outcomes.
2. Add semantic status fields to Hatchet metadata and dashboard debug panels.
3. Add workspace validation command and print a clear startup summary in
   `yarn runtime`.
4. Add agent input example discovery from workspace files or manifests.
5. Add normalized graph persistence tables once the projection model stabilizes.
6. Add operator actions only after cancellation and idempotency semantics are
   implemented.

## Useful Commands

Start infra:

```bash
yarn hatchet:poc:up
```

Run local runtime apps:

```bash
yarn runtime
```

Run worker and host without starting another dashboard dev server:

```bash
yarn runtime --no-dashboard
```

Build affected packages:

```bash
yarn workspace @a2arium/callagent-core build
yarn workspace @a2arium/callagent-driver-hatchet build
yarn workspace @a2arium/runtime-host build
yarn workspace @a2arium/hatchet-worker build
yarn workspace @a2arium/operator-viewer build
```

Run the operator graph regression test:

```bash
yarn test packages/core/tests/operator.runGraph.test.ts --runInBand
```
