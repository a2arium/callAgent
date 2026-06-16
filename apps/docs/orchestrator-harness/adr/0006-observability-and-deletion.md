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

Use Hatchet UI for infrastructure history and callAgent artifacts for cognition.
Link them with:

- run metadata (`tenantId`, `agentId`, `taskId`, `traceId`, `token`,
  `idempotencyKey`, `operation`);
- composite search keys (`tenantTaskKey`, `tenantTraceKey`, `taskTokenKey`);
- a local `driver_runs` table for exact joins and deep links.

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

- Operators use a two-pane story: Hatchet for infrastructure, callAgent for
  cognition.
- Hatchet retention is operational history, not long-term audit.
- We avoid accumulating both old and new coordination paths indefinitely.

## Open Validation

- B5/B6/B7 verify the self-hosted UI and manual operations.
- B11 verifies retention/storage behavior.
- D3 verifies `driver_runs` mapping and deep links.
