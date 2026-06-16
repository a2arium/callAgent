# ADR 0010: Cancellation Semantics

## Status

Proposed

## Context

`RuntimeDriver.cancel(...)` exists in the port (`specs/runtime-driver-port.md`)
but its semantics are unspecified. Research A6 answered the shape conceptually
(await-boundary cancellation, not mid-turn preemption); this ADR makes it
normative and ties it to the segment model.

Constraints from the rest of the design:

- A segment is opaque and non-deterministic (ADR 0002); we cannot safely
  interrupt it mid-LLM/mid-tool without making the loop and every tool
  cancellation-aware, which is out of scope for v1.
- `MentalState` and task lifecycle live in callAgent (ADR 0005); Hatchet only
  schedules. Cancellation intent must therefore be authoritative in the snapshot,
  not only in Hatchet.
- Hatchet supports graceful run cancellation and exposes a cancellation
  signal/`ctx.cancelled` to task code, but a running non-deterministic segment
  should finish its current effect boundary rather than abort partway.

## Decision

v1 cancellation is **boundary cancellation**, not mid-segment preemption:

```text
cancel(taskId, reason):
  1. callAgent marks cancellation intent in the snapshot (authoritative),
     transactionally with a status -> 'canceled' intent.
  2. pending tokens for the task become non-resumable: any wake matching them is
     a durable no-op (reuses the ADR 0005 dedupe/guard path).
  3. queued/not-yet-started Hatchet runs for the task are cancelled where
     possible (best-effort).
  4. a currently-running segment is allowed to finish its current effect
     boundary; it is not force-killed.
  5. at the next boundary/wake, the durable loop observes cancellation intent and
     stops instead of scheduling the next segment; the task ends 'canceled'.
```

### Ownership split

| Concern | Owner |
|---|---|
| cancellation intent (source of truth) | callAgent snapshot |
| ignoring pending-token wakes after cancel | callAgent (dedupe/guard) |
| cancelling queued Hatchet runs | `HatchetRuntimeDriver` (best-effort) |
| stopping the durable loop at next boundary | durable task, reading the result |
| terminal `canceled` status + stream event | callAgent (canonical contract) |

### Idempotency

`cancel` is idempotent: cancelling an already-canceled or terminal task is a
no-op. The cancel itself carries `idempotencyKey = taskId:cancel`.

### Races

- **cancel vs in-flight resume:** the resume may still apply if it commits first;
  the next boundary then observes cancellation and stops. No partial corruption
  because both go through the same CAS + dedupe path.
- **cancel vs completion:** if the task completes before cancel is observed,
  completion wins; cancel becomes a no-op.
- **cancel vs child tasks:** parent cancellation requests child cancellation
  (best-effort) but parent fan-in logic (callAgent) stops scheduling regardless.

## Consequences

- No need to make the APLRET loop, LLM calls, or tools cancellation-aware in v1.
- Cancellation latency is bounded by the current segment's remaining effect
  boundary, which is acceptable for v1 (documented, not interactive-real-time).
- Mid-segment hard preemption (abort an in-flight LLM/tool) is explicitly a
  **future** option, requiring cooperative cancellation in the loop/tools.

## Open Validation

- POC: cancel a task waiting on `await_tool`; a late tool result is a no-op and
  the task ends `canceled`.
- POC: cancel a task with 5 in-flight children; parent stops fan-in, children are
  cancelled best-effort, no parent resume occurs after cancel.
- POC: double cancel and cancel-after-complete are both no-ops.
