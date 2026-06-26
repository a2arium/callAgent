# Operator Viewer Spec

## Status

Implementation spec for the Phase 3.1 Operator Dashboard MVP.

Canonical companion docs:

- [`../Operator Dashboard — UI/UX Development Requirements v1.0.md`](../Operator%20Dashboard%20%E2%80%94%20UI%2FUX%20Development%20Requirements%20v1.0.md) — UI/UX requirements, stack decision, auth/security reservations, and MVP scope.
- [`../../operator-run-graph.md`](../../operator-run-graph.md) — semantic run graph contract and product-level data model.
- [`../adr/0006-observability-and-deletion.md`](../adr/0006-observability-and-deletion.md) — compact operator event capture in `wm_events`.

## Purpose

The operator viewer is the customer-facing surface for understanding agent
orchestration. It starts at a fleet list, drills into one semantic agent DAG, and
then exposes turn cognition, LLM metadata, memory key activity, and debug effects.
Hatchet remains a deep-link target for backend execution debugging, not the primary product model.

## Data Sources

No graph tables are introduced in this track.

- `driver_runs`: provider/backend index, root run list, Hatchet ids, turn/effect
  rows, parent/child graph fields, and list-oriented indexes.
- `wm_events`: task lifecycle plus compact operator events:
  `turn.completed`, `memory.read`, `memory.write`, `memory.delete`.
- `wm_sessions`: current task snapshot and agent attribution.
- callllm/application telemetry: optional owner of full prompt/response capture outside callagent.

## Capture Rules

`observability.turnTrace.enabled` controls compact operator capture. When omitted,
capture is enabled. `observability.turnTrace.level` defaults to `summary`; `full`
permits larger previews but still truncates payloads.

`turn.completed` stores:

- `turnSeq`, `turnId`, `agentId`, `taskId`
- stage before/after and transition
- compact intent, shield, perception, exec action/result
- timings and usage
- LLM call metadata (model, provider, tokens, cost, latency)
- child/tool summaries
- mental-state hashes
- trace/span refs

`memory.*` stores:

- operation (`read`, `write`, `delete`)
- keys and key count
- backend/source
- `turnSeq`, `agentId`, trace/span refs

Raw memory values and full LLM prompts/responses are not stored in `wm_events`.

## API Contract

### Fleet List

```http
GET /agent-runs?agentId=<agent>&status=<status>&since=<iso>&cursor=<cursor>&limit=<n>
x-tenant-id: <tenant>
```

Returns:

```json
{
  "items": [
    {
      "agentId": "coordinator",
      "taskId": "task-1",
      "rootTaskId": "task-1",
      "status": "completed",
      "startedAt": "2026-06-19T10:00:00.000Z",
      "finishedAt": "2026-06-19T10:00:05.000Z",
      "durationMs": 5000,
      "turns": 3,
      "children": 2,
      "llmCalls": 4,
      "costUsd": 0.0123,
      "traceId": "trace-1",
      "providerRunId": "hatchet-run-1"
    }
  ],
  "nextCursor": "opaque"
}
```

### Run Graph

```http
GET /tasks/:taskId/run-graph
x-tenant-id: <tenant>
```

Returns `AgentRunGraph` with `root`, `nodes`, `edges`, `turns`, `memoryOps`,
`effects`, `events`, and debug driver rows.

### Turn Detail

```http
GET /tasks/:taskId/turns/:turnSeq
x-tenant-id: <tenant>
```

Returns one `TurnRun` enriched with cognition, LLM metadata, memory ops, and
trace refs.

### Memory Detail

```http
GET /tasks/:taskId/memory
x-tenant-id: <tenant>
```

Returns the current memory snapshot visible in the task snapshot plus the compact
memory operation timeline.

## SPA Contract

`apps/operator-viewer` is a Vite/React/TypeScript single-page app served by
`runtime-host` under `/operator` when built.

Committed frontend stack:

- shadcn-style component layer (Radix primitives + Tailwind CSS tokens).
- TanStack Router for route and URL search state.
- TanStack Query for existing runtime-host endpoint access and manual refresh.
- TanStack Table + TanStack Virtual for the Fleet table.
- React Flow + deterministic dagre layout for the Visual Agent Run Graph.
- Lucide icons for non-color status language.

The implementation is frontend-first against existing endpoints. New UI-shaped
operator endpoints (`/operator/runs/...`), server-computed failure paths, true
fleet aggregates, and server-side graph windowing are deferred backend scope.

- App shell: environment/tenant indicators, manual refresh/freshness language,
  reserved user/help area, dark-mode token base.
- Fleet view: URL-shareable filters, page-scoped summary strip, virtualized
  table, non-color status badges, safe empty/error states.
- Run view: sticky header, investigation summary, React Flow semantic DAG,
  client-derived failure path/default node selection, and selected-node inspector.
- Node inspector:
  - Summary
  - Turns with APLRET cognition stepper
  - LLM metadata and copyable trace/span identifiers
  - Memory key timeline
  - Hatchet links and copyable identifiers
- Deep links:
  - `VITE_HATCHET_DASHBOARD_URL` for provider run ids

Safety rules:

- Raw prompts/responses are never rendered inline.
- Raw memory values are never rendered inline.
- Raw input/output previews are hidden until server-side preview sanitization
  exists.
- Missing values use explicit language (`Not captured`, `Unavailable`,
  `Preview hidden for safety`) and are never treated as zero.

In development, Vite proxies `/agent-runs` and `/tasks` to `runtime-host`. When
the SPA is built, `runtime-host` serves `/operator` if `apps/operator-viewer/dist`
or `OPERATOR_VIEWER_DIST` contains `index.html`.

## Acceptance

- A tenant with thousands of root runs can be filtered and paged without loading
  every run graph.
- Opening a run shows the semantic DAG and hides raw `aplret.*` vocabulary by
  default.
- Operators can inspect decisions, transitions, timings, LLM cost/latency
  metadata, and memory key activity.
- Full prompts/responses and raw memory values are absent from callAgent SQL
  storage.
- Hatchet links are available when provider run ids exist, and trace/span ids are copyable when captured.
