# ADR 0006: Observability And Deletion

## Status

Proposed

## Context

The orchestrator provides an operations UI for runs, retries, logs, and queues.
It does not understand APLRET cognition: `MentalState`, turn modules,
observations, intents, pending tokens, or `TurnTrace`.

The transition should also remove runtime code that exists only because current
coordination is in-process, but deletion must not happen before the replacement
surface is proven.

## Decision

Use Hatchet UI for infrastructure history and callAgent artifacts for cognition,
but expose a callAgent `AgentRunGraph` as the operator-facing product surface.
Link the layers with:

- run metadata (`tenantId`, `agentId`, `taskId`, `traceId`, `token`,
  `idempotencyKey`, `operation`, `rootTaskId`);
- composite search keys (`tenantTaskKey`, `tenantTraceKey`, `taskTokenKey`);
- a local `driver_runs` table for exact joins and deep links.
- semantic graph records or projections: `AgentRun`, `AgentRunEdge`, `TurnRun`,
  `EffectRun`, and grouped events/logs.
- compact operator events in existing `wm_events`:
  - `turn.completed` for turn stage, decision, shield, transition, timings,
    usage, LLM metadata, child summaries, and trace/span references;
  - `memory.read`, `memory.write`, `memory.delete` for memory operation keys,
    backend, agent, turn, trace, and span.

`driver_runs` is the provider/backend index. It must not become the product model.
The operator graph answers user questions in agent vocabulary and hides
`aplret.segment` / `aplret.outbox.dispatch` behind debug details.

The operator event taxonomy is deliberately compact. `wm_events` may store
summaries and identifiers, but not raw LLM prompts/responses or raw memory
values. `observability.turnTrace.enabled` gates capture. `summary` is the
default level; `full` may include larger previews, but still applies truncation
and remains unsuitable for long-term prompt/value audit. Full cognition and
prompt/response debugging belongs to application-level telemetry outside the
callagent SQL projection.

Outbox migration uses one authoritative delivery path per event type:

```text
existing outbox table -> HatchetOutboxDispatcher -> existing event bus
```

The in-process `OutboxPublisher` remains fallback until each event type is proven.

Deletion policy:

- Mark obsolete code in `specs/deletion-inventory.md`.
- Delete only after the relevant Hatchet surface has passed POC gates.
- Keep a configuration fallback until the next stabilization phase.

## Consequences

- Operators use the callAgent run graph first: agent status, input/output,
  child calls, failures, compact turn cognition, LLM metadata, memory keys,
  TurnTrace refs, and logs/events. Hatchet is the linked infrastructure/debug
  pane.
- Hatchet retention is operational history, not long-term audit.
- Long-term audit and product UX require normalized graph persistence or an
  equivalent durable projection; reconstructing from arbitrary JSON payloads is
  acceptable only as an interim implementation.
- We avoid accumulating both old and new coordination paths indefinitely.

## Open Validation

- B5/B6/B7 verify the self-hosted UI and manual operations.
- B11 verifies retention/storage behavior.
- D3 verifies `driver_runs` mapping and deep links.
- Operator graph validation verifies that a user can answer which agent ran,
  what it received/output, what child agents it called, what failed, and where
  the relevant TurnTrace/raw Hatchet run ids are.
- Operator Experience validation verifies fleet filtering, DAG drill-down,
  compact LLM cost/latency metadata, memory key timelines, Hatchet deep links,
  and copyable trace/span identifiers without adding graph tables.
