# ADR 0004: External Wakes As Events

## Status

Proposed

## Context

Today, external wakes enter the runtime through direct methods such as
`resumeInput`, `handleToolCompleted`, `handleExternalEventOccurred`, and
`handleChildCompleted`. These methods load snapshots, append observations, save
with CAS, and sometimes immediately run another turn.

Hatchet durable event waits are designed for this shape: a durable task waits on
a stable event key, and an external callback pushes the matching event.

Interactive chat/SSE resumes are latency-sensitive and should not be forced
through a durable queue hop by default.

## Decision

In Hatchet mode, non-hot external wakes become Hatchet events:

| Wake source | Hatchet event |
|---|---|
| user input (non-hot path) | `aplret.input.<token>` |
| tool/webhook result | `aplret.tool.<token>` |
| child completion | `aplret.child.<token>` |
| timer fire | `aplret.timer.<token>` |
| external event | `aplret.external.<token>` |

The Hatchet durable task waits for the event key derived from the pending token,
then spawns the next `aplret.segment` child with a small inbox event payload.

Event keys are derived only from tokens that were returned as checkpoint outputs
by a prior segment (ADR 0002 — token provenance). The durable task never invents
a token to wait on.

Hot chat/SSE resumes remain in-process by default. They may be moved to Hatchet
only after latency benchmarks prove it safe.

## Consequences

- The durable task owns wake ordering in Hatchet mode.
- Direct in-process race workarounds can be deleted after equivalent event waits
  are proven.
- The runtime still accepts the same public RPC/chat APIs; only the delivery
  path changes.

## Open Validation

- B3 duplicate resume no-op.
- B8 latency comparison: in-process hot resume vs Hatchet async resume.
- B9 child completion events out of order and one child failing/retrying.
