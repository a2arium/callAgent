# Driver Sync vs Async API

## Problem

The `RuntimeDriver` port (`specs/runtime-driver-port.md`) defines **async**
scheduling: `enqueueStart` / `enqueueResume` resolve when work is *scheduled*,
not when a segment *completes*. That matches durable orchestrators (Hatchet):
the API host enqueues; workers run segments; completion is observed via task
state / stream events.

Phase 0 `TaskEngine` call sites **await** segment completion today (`startTask`
loop mode, `resumeInput`, tool/external/conversation auto-resume). Bridging that
gap without changing caller-visible behavior required sync extensions on the
in-process driver only.

## Decision

| API | Owner | Semantics | Used by |
|---|---|---|---|
| `enqueueStart` / `enqueueResume` | `RuntimeDriver` port | Fire-and-forget schedule | Timers (`scheduleTimer` callback), future Hatchet driver |
| `enqueueStartSync` / `enqueueResumeSync` | `InProcessRuntimeDriver` only | Await segment completion | `TaskEngine` Phase 0 routing |
| `PreparedTurnInvocation` | `RunSegmentParams` | Skip wake applicator; preserve TaskEngine-prepared ctx/snapshot | All current `TaskEngine` sync paths |

`TaskEngine.runPreparedTurnThroughDriver` uses `isSyncRuntimeDriver()`; non-sync
drivers fall back to direct `turnRunner.runTurn` until Hatchet mode migrates
call sites to async observation.

## Hatchet mode (Phase 2+)

In Hatchet mode, `TaskEngine` RPC handlers should **not** await segments:

1. `enqueueStart` / `enqueueResume` schedule `aplret.segment` (or push events).
2. Completion is observed via existing task status / canonical stream events.
3. Hot chat/SSE paths may remain on `InProcessRuntimeDriver` sync extensions
   (ADR 0004 hybrid latency model).

Do **not** add `enqueueStartSync` to `HatchetRuntimeDriver`. The sync methods
are a Phase 0 parity shim, not part of the durable contract.

## Test implications

- Scenario 0 (in-process parity) validates sync routing + unchanged outcomes.
- Parity harness (pre-deletion) must compare canonical traces under async
  Hatchet scheduling vs in-process sync scheduling — not byte-identical call
  graphs.
