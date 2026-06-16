# Deletion Inventory

Line-referenced inventory of code that becomes a candidate for replacement or
deletion after the Hatchet driver proves the equivalent surface.

**Rule:** nothing in this file is deleted during planning. Delete only after the
replacing surface has passed POC gates, is behind a reversible flag, and the
in-process driver remains green.

## Category A — outbox poller

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/eventbus/outboxPublisher.ts` lines 86–116, 148–198 | Polls DB outbox every ~500ms, dispatches rows, retries/dead-letters. | `aplret.outbox.dispatch` consuming existing outbox rows. |
| `packages/core/src/orchestration/taskEngine.ts` lines 368–380, 3639–3641 | Starts/stops embedded `OutboxPublisher`. | Driver-managed outbox dispatch. |

Delete only per event type after no dual delivery path exists.

## Category B — resume auto-scheduling

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/orchestration/taskEngine.ts` lines 1502–1722 | `resumeInput` appends observation, saves, and immediately schedules/runs next turn. | Hatchet event wait wakes `aplret.task`, which spawns `aplret.segment`. |
| `packages/core/src/orchestration/taskEngine.ts` lines 1783–1828 | `handleToolCompleted` injects into active loop or runs next turn. | `aplret.tool.<token>` event. |
| `packages/core/src/orchestration/taskEngine.ts` lines 1858–1912 | external event auto-resume. | `aplret.external.<token>` event. |

Public RPC methods remain; only their internal scheduling path changes.

## Category C — child completion race handling

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/orchestration/taskEngine.ts` line 209 | `childCompletionInFlight` duplicate counter. | Hatchet per-task serialization + callAgent idempotency. |
| `packages/core/src/orchestration/taskEngine.ts` lines 1919–2054 | `stageChildCompletionObservation` with CAS retry. | Parent durable task waits on child completion event. |
| `packages/core/src/orchestration/taskEngine.ts` lines 2158–2238 | child-completion snapshot CAS save retry loop. | Single serialized `aplret.segment` child with CAS/idempotency. |
| `packages/core/src/orchestration/taskEngine.ts` lines 2320–2717 | parent resume retry loop after child completion. | Durable event wait resumes parent control loop. |
| `packages/core/src/orchestration/A2AService.ts` lines 358–392 | `queueMicrotask` deferred `handleChildCompleted`. | Event push to Hatchet. |
| `packages/core/src/orchestration/api/ApiBinder.ts` lines 397–435 | active-loop child injection vs direct `handleChildCompleted`. | Hatchet event wait; no mid-loop injection. |

## Category D — active loop injection

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/orchestration/LoopRegistry.ts` entire file | Tracks active loop contexts for tool/child injection. | Durable event wait + serialized turn child. |
| `packages/core/src/orchestration/TaskExecutor.ts` lines 187–237 | Registers/clears active loop context. | Hatchet driver owns wake ordering. |
| `packages/core/src/loop/loopRunner.ts` lines 1462–1607 | Converts already-arrived tool/child result from inbox/DB into `continue` to avoid double resume. | Durable event wait handles arrival ordering. |
| `packages/core/src/orchestration/TurnRunner.ts` lines 243–309 | Backfills child observations from event log when inbox is empty on resume. | Hatchet event delivery ordering. |

## Category E — in-process coordination and retry backoff

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/orchestration/taskEngine.ts` lines 388–518, 431–488 | conversation activation queues and `runTaskSessionExclusive`. | Per-task concurrency key and driver scheduling in Hatchet mode. |
| `packages/core/src/orchestration/taskEngine.ts` lines 2033, 2202, 2710 | CAS retry backoffs in child completion/resume races. | Serialization reduces contention; CAS remains guard. |
| `packages/core/src/orchestration/engine/FlushScheduler.ts` entire file | In-process debounced snapshot flush. | Review after `TurnExecutor` has one clear persistence boundary. |
| `packages/core/src/orchestration/Handles.ts` lines 214–235 | Snapshot load retry in task handle creation. | Review after child dispatch moves to Hatchet. |

## Category F — legacy and temporary compatibility

| Candidate | Current role | Replacement |
|---|---|---|
| `packages/core/src/orchestration/taskEngine.ts` lines 1274–1373 | legacy handler post-processing path. | Candidate only if all supported agents are loop-first. Not part of Hatchet POC deletion. |
| `packages/core/src/api/rpc/IdempotencyStore.ts` entire file | In-memory 10-minute idempotency cache for `tasks/input`. | Durable idempotency store if Hatchet mode needs process-restart safety. |

## Keep

Do **not** delete these as part of orchestrator adoption:

- `oneTurn` / APLRET modules / stage contracts.
- `runLoop` until the `TurnExecutor` wrapper proves exactly which behavior it
  needs from it.
- `SessionManager`, `SnapshotRepository`, CAS, and `wmVersion`.
- Canonical runtime stream events and projection code.
- `TurnTrace` and telemetry.
- `IEventBus` / `MessageLog` conversation transport unless a separate project
  explicitly replaces them.
