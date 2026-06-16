# Hatchet POC Scenarios

These scenarios validate the architecture before committing to Hatchet as the
production substrate. They are intentionally small and deterministic.

## Scenario 0 — in-process parity

Purpose: prove the seam does not change current behavior.

```text
driver = in-process
start demo task
task requests input
resume with input
task completes
```

Expected:

- existing tests pass unchanged;
- no Hatchet service required;
- stream/TurnTrace output matches current behavior.

Gates: D1, D5.

## Scenario 1 — outbox dispatch

Purpose: validate the lowest-risk Hatchet surface.

```text
create outbox rows for task.status / task.input_required
disable old poller for that event type
trigger aplret.outbox.dispatch
publish event to existing event bus
mark row delivered
fail one dispatch intentionally
operator replays from Hatchet UI
```

Expected:

- exactly one authoritative delivery path per event type;
- failed run shows payload, error, attempts, logs;
- replay works from self-hosted UI;
- operator can search by `tenantTaskKey` / `traceId`.

Gates: B5, B6, B7.

## Scenario 2 — async resume

Purpose: validate one non-hot wake through Hatchet.

```text
start task
turn returns await_tool token
push aplret.tool.<token> with result
Hatchet durable task resumes
aplret.segment runs to next boundary
task completes
push duplicate aplret.tool.<token>
```

Expected:

- one effective observation applied;
- duplicate wake is no-op at callAgent effect boundary;
- per-task concurrency key serializes the turn;
- run metadata links to TurnTrace.

Gates: B1, B3, B4, B8.

Crash variant:

```text
kill worker during aplret.segment
restart worker
observe retry/redelivery
```

Expected: one effective snapshot transition.

Partial-effect crash variant (ADR 0009):

```text
segment performs: tool call + outbox enqueue + stream events
kill worker AFTER those effects but BEFORE the boundary snapshot commits
restart worker; Hatchet redelivers the wake
segment re-runs from the wake
```

Expected:

- tool is not double-executed (deduped by `taskId:turnSeq:toolCallId`) or is
  proven safe to repeat;
- outbox event is not duplicated downstream (`taskId:turnSeq:eventKind`);
- stream consumers dedupe by `seq`;
- exactly one effective snapshot transition after recovery.

Retry-classification variant (ADR 0009):

```text
inject a transient LLM 5xx  -> segment throws
inject a deterministic policy/validation fail -> segment returns fail boundary
```

Expected:

- transient error retried up to the bound, then dead-letters in Hatchet;
- `fail` boundary is terminal and NOT retried by Hatchet.

Gates: B1, B3, B4, B8, ADR 0009.

## Scenario 3 — child fan-out / fan-in

Purpose: validate Hatchet child spawning without moving parent cognition into
Hatchet state.

```text
parent turn returns await_child group of 5
Hatchet dispatches 5 child tasks
children complete in random order
one child fails then retries
parent resumes only when callAgent token/group logic says complete
```

Expected:

- child runs searchable by parent `taskId` / `traceId`;
- duplicate child completion is no-op;
- parent `MentalState` and fan-in decision live in callAgent snapshot;
- canonical child debug stream events remain correct.

Gates: B9 plus B3.

## Scenario 4 — timer / sleep

Purpose: validate durable sleep and reconciliation.

```text
turn returns await_input with expiresAt = now + 5 minutes
Hatchet durable task sleeps until expiresAt
restart worker before dueAt
restart Hatchet engine before dueAt
simulate full downtime during dueAt
TimerReconciler scans overdue token
push aplret.timer.<token>
```

Expected:

- timer fires once under normal restart;
- downtime-during-fireAt is recovered by reconciler;
- duplicate fire is no-op;
- expired token behavior matches current `resumeInput` expiry contract or the
  new documented timer contract.

Gate: B2.

## Scenario 5 — cancellation

Purpose: validate boundary cancellation (ADR 0010).

```text
task awaits tool/input
operator cancels from callAgent/Hatchet path
snapshot marks cancellation intent (authoritative)
queued Hatchet runs cancel where possible
late tool/input event arrives
```

Expected:

- late wake is ignored/no-op (pending tokens non-resumable);
- a running segment finishes its current effect boundary (no mid-segment kill);
- task ends `canceled`; no zombie resume occurs.

Variants (ADR 0010):

```text
cancel a task with 5 in-flight children
double cancel
cancel after complete
```

Expected:

- parent stops fan-in; children cancelled best-effort; no parent resume after
  cancel;
- double cancel and cancel-after-complete are both no-ops.

Gate: R-F9 / ADR 0010.

## Scenario 6 — operator flow

Purpose: validate the two-pane ops story.

```text
failed Hatchet run
search by tenantTaskKey / traceId
open Hatchet timeline/logs
follow deep link to callAgent task / TurnTrace
retry or cancel
```

Expected:

- operator can find the failed run in under 30 seconds;
- Hatchet shows infra attempt history;
- callAgent shows cognition trace;
- retry/cancel is available without Hatchet Cloud.

Gates: B5, B6, B7, D3.

## Scenario 7 — upgrade and retention (production gate)

Purpose: validate operational readiness.

```text
start 50 runs
start 10 timers/sleeps
keep 5 tasks waiting
upgrade Hatchet control plane
verify timers/runs
rollback if needed
generate 100k synthetic runs
measure DB size and dashboard speed
```

Expected:

- no lost scheduled waits;
- no duplicate callAgent effects;
- runbook exists;
- retention and storage volume are acceptable.

Gates: B10, B11, C2, C3.

## Scenario 8 — driver parity harness (cross-cutting)

Purpose: prove the two drivers are behaviorally equivalent before any in-process
code is deleted (ADR 0007 streaming parity + safety net for the deletion
inventory).

```text
for each scenario above (0,2,3,4,5):
  run under driver = in-process  -> capture canonical event trace
  run under driver = hatchet      -> capture canonical event trace
  normalize volatile fields (timestamps, run ids)
  assert traces are identical (order, visibility, finality)
```

Expected:

- identical projected SSE/chat output under both drivers;
- any divergence is a release blocker until reconciled.

Gates: ADR 0007, D5.

## Pivot rules

```text
B1 or B3 or B7 fail        -> Temporal Activity-only fallback POC
B2 fails + no reconciler   -> no Hatchet timer ownership
B5 or B6 fail              -> re-evaluate UI requirement or pg-boss Phase 1 fallback
ADR 0009 effect dedupe unworkable -> defer async resume/child to in-process;
                                     keep Hatchet for outbox/timers only
```
