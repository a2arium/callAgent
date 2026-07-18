# Bug Report: Streaming runner can fail an active task graph during background drain

> **Status:** Implemented and framework-verified; host payload follow-up required
>
> **Severity:** High. The SQL-backed streaming runner can replace a legitimately
> progressing root task with `BackgroundTaskDrainError`, lose the authoritative
> application result, and leave the durable graph active.
>
> **Related work:** `0ef46ff fix: reject effects from terminal task branches`
> correctly protects terminal ownership. This report concerns a different
> boundary: the runner starts background drain while the returned root is still
> active and awaiting child work.

## Summary

`streamingRunner` treats an `await_*` result from `TaskEngine.startTask()` as an
active graph and calls `engine.drainBackgroundTasks()` with a run-sized timeout.
The drain implementation waits for transient in-memory background idleness, not
for the durable root task to become terminal. A long, sequential APLRET workflow
can therefore remain validly active while the drain reaches an inconsistent
completion/failure boundary.

The fresh `FIX-S17 --site-config-only` reproduction failed after approximately
5.5 minutes. At the failure boundary:

- the root lifecycle was `active`;
- the root had just started and still owned a router child;
- the router lifecycle was `active` and still owned a browser child;
- the browser lifecycle was `active` and had a pending MCP tool;
- `task.tool_requested` was durably committed 207 ms before the final failure;
- the in-memory drain diagnostic described the same tool as `active` and only
  102 ms old;
- the workflow was on turn 39 of a configured 320-turn budget;
- the scenario's 1,200,000 ms outer deadline had not expired.

This is legitimate active-graph progress, not a late effect registered by a
terminal branch. Nevertheless, the runner emitted a synthetic final `failed`
status with empty metadata and exited nonzero.

## Environment

- CallAgent branch: `hatchet`
- CallAgent commit: `a28732f`
- Terminal effect-registration fix: `0ef46ff`
- Host: `/Users/maximantonov/Work/_lab/itupdated`
- Host scenario: `FIX-S17 --site-config-only`
- Runtime: real PostgreSQL-backed streaming runner with nested browser-use MCP
  tools
- Date reproduced: 2026-07-18

## Reproduction

From the `itupdated` checkout, build the host and run:

```bash
yarn run:testscenario FIX-S17 --site-config-only
```

The relevant root and final nested tasks in the reproduced run were:

```text
root:    local-task-1784361677399
router:  a2a_local-task-17843_fetch-page-route_1784362008453_z7h0s9muo
browser: a2a_a2a_local-task-1_fetch-browser_1784362008553_bq36l0q8r
tool:    tool-019f7443-8046-7ee0-b46f-57514c7d73a9
```

The runner failed with:

```text
Background task drain incomplete after 318709ms
remainingPromises: 1
state: active
ageMs: 102
toolName: mcp:browser-use.navigate_and_extract
rootTaskId: local-task-1784361677399
```

It then published:

```json
{
  "type": "status",
  "status": "failed",
  "final": true,
  "metadata": {}
}
```

The host trace is:

```text
/Users/maximantonov/Work/_lab/itupdated/src/temp/logs/scenarios/FIX-S17/site-config-discovery-trace.json
```

## Durable SQL Evidence

Immediately after the runner exited, all three task lifecycle snapshots remained
`active`. The ownership chain was intact:

```text
root active
  pending child -> router active
    pending child -> browser active
      pending tool -> browser-use.navigate_and_extract
```

The final durable event sequence was:

```text
08:06:48.498 root    task.child_started
08:06:48.541 router  task.started
08:06:48.594 router  task.child_started
08:06:48.616 browser task.started
08:06:48.662 browser task.tool_requested
08:06:48.665 browser turn.completed
08:06:48.688 router  turn.completed
08:06:48.702 root    turn.completed
08:06:48.710 root    turn.started
08:06:48.717 root    turn.completed
08:06:48.869 runner  final failed status
```

No task or ancestor was terminal when the tool registered. The registration was
therefore correctly accepted by `TaskEffectRegistration`; it is the runner's
active-graph waiting boundary that failed.

## Suspected Root Cause

This is host-side analysis, not a confirmed framework diagnosis.

`streamingRunner.ts` recognizes that an `await_*` return is active execution, but
still delegates the completion decision to:

```ts
await engine.drainBackgroundTasks({
  rootTaskId,
  timeoutMs,
  throwOnTimeout: true,
});
```

`waitForBackgroundTasks()` considers the graph idle when its current in-memory
background promise set and conversation activation set are empty across a short
grace interval. It does not require the durable root lifecycle to be terminal.
Sequential workflows naturally have brief handoff gaps between a child result,
the root's next policy turn, and registration of the next child/tool. Conversely,
after the loop, `runtimeDriver.waitForIdle()` and a final point-in-time background
snapshot can observe newly active work without re-entering a lifecycle-aware wait.

The result is a race between transient idleness, newly scheduled active work, and
the drain's timeout/exit path. `BackgroundTaskDrainError` is appropriate for
terminal cleanup leaks; it is not an authoritative application failure while the
root lifecycle remains active.

## Required Framework Contract

### 1. Active graph execution must wait for root terminality

When `startTask()` returns a non-terminal `await_*`/`working` status, the streaming
runner must continue driving or observing the graph until the durable root enters
`completed`, `failed`, or `canceled`. Background idleness alone must not be treated
as root completion.

### 2. Separate execution deadline from terminal drain

Use two distinct boundaries:

1. an active-run deadline while the root is non-terminal;
2. a short cleanup drain after the root is durably terminal.

If the active-run deadline expires, atomically terminalize/cancel the root with a
typed reason, detach its owned effects, and publish that authoritative terminal
result before cleanup. Do not throw `BackgroundTaskDrainError` while leaving the
durable root active.

### 3. Make idle observations lifecycle-aware and race-safe

An idle observation should be accepted only after re-reading the durable root and
confirming terminality. If the root is active, continue waiting for task events or
runtime wakes. Re-check after `runtimeDriver.waitForIdle()` because new nested work
may have been registered during the wait.

### 4. Preserve the authoritative result

Runner cleanup errors must not replace an already durable terminal application
result. If cleanup fails after terminality, preserve the result and attach cleanup
diagnostics separately. If execution times out before terminality, publish a typed
timeout/cancellation result with the durable terminal lifecycle and reason.

### 5. Keep terminal effect registration behavior unchanged

Do not weaken `0ef46ff`. Terminal/detached owners and ancestors must continue to
reject new effects. This fix should correct the active-root waiting protocol, not
permit terminal branches to keep working.

## Decision-Complete Implementation Plan

### Task-state classification

Use an explicit root-run classifier instead of treating every non-terminal status
as active internal execution:

- `completed`, `failed`, and `canceled` are terminal;
- `input-required` is externally suspended and must be published without waiting
  for or consuming the active-run deadline;
- `submitted` and `working` with `await_child`, `await_tool`, or `await_event` are
  internally active and remain under the active-run deadline.

Background idleness never changes this classification. The durable root snapshot
is authoritative.

### Atomic task-terminal coordination

Introduce a shared `coordinateTaskTerminal` reconciliation path for completion,
failure, manual cancellation, and active-run timeout. Its mutation reloads the
latest snapshot on every compare-and-set attempt and returns an explicit
disposition:

- `committed`: this caller won the terminal claim;
- `matching_replay`: the same terminal outcome was already committed;
- `competing_terminal`: a different terminal outcome already won;
- `missing_task`: the durable task does not exist.

The committed snapshot atomically records lifecycle state, reason, bounded
terminal status metadata, a deterministic delivery key, and branch-cleanup intent.
Only `committed` may append the normal task event and publish the initial outbox
status. `matching_replay` may republish the same deterministic outbox delivery
after recovery. A competing outcome must use the winner's authoritative status and
perform no terminal publication of its own.

Refactor `cancelTask` so terminality is checked inside this mutation rather than
only before reconciliation. Completion/failure persistence must return the
coordinator disposition to `TaskEngine`; a locally computed completion must not
append `task.completed` after cancellation has won. Parent notification and branch
cleanup use the committed snapshot, never the stale snapshot loaded before the
claim.

### Durable terminal publication

Persist a bounded terminal publication record in snapshot JSON, for example:

```ts
meta.taskTerminal = {
  state: 'completed' | 'failed' | 'canceled',
  status: BoundedTerminalTaskStatus,
  deliveryKey: string,
  claimedAt: string,
  enqueuedAt?: string,
}
```

The stored status may contain bounded scalar metadata and references to artifacts
or externally stored results. It must not duplicate arbitrary result bodies,
tool output, or artifact content into working memory. Recovery republishes an
unenqueued terminal record through the existing idempotent outbox path and marks
it enqueued best-effort after the outbox write. A crash after enqueue but before
marking is safe because the delivery key is deterministic. Diagnostic event append failure does not
invalidate the committed terminal claim.

### Active-run deadline and recovery

The deadline starts when the root `startTask()` invocation begins, including its
initial segment. Persist one immutable root deadline containing `timeoutMs`,
`expiresAt`, configuration source, and a deterministic timer token. Register the
deadline and timer-scheduling intent before active execution can be treated as
detached from the entrypoint.

Add internal timer kind and reason `task_run_timeout`. SQL/Hatchet execution uses
`RuntimeTimerRepository`; pure in-memory execution uses a local timer. Scheduling
is idempotent. Startup reconciliation and `awaitTaskTerminal` must recreate a
missing timer after a crash between snapshot commit and timer scheduling.

On expiry, call `coordinateTaskTerminal` with:

```ts
{
  state: 'canceled',
  metadata: {
    code: 'TASK_RUN_TIMEOUT',
    reason: 'active_run_timeout',
    timeoutMs,
    expiresAt,
  },
}
```

The winner detaches the root branch, cancels remaining timers, requests provider
cancellation best-effort, and publishes the authoritative canceled status before
cleanup. A typed `TaskRunTimeoutError` may be exposed by APIs that throw, but a
runner must not send an already committed timeout through its generic exception
handler and synthesize a second failed status.

Configuration precedence is:

1. `CALLAGENT_ACTIVE_RUN_TIMEOUT_MS`;
2. `REAL_RUN_TIMEOUT_MS`;
3. manifest latency budget plus the existing grace;
4. the existing 15-minute active-run default.

`CALLAGENT_BACKGROUND_TASK_TIMEOUT_MS` applies only to terminal cleanup and keeps
the existing 60-second default when unset.

### Root lifecycle observation and runtime adoption

Add `TaskEngine.awaitTaskTerminal()` for entrypoints that own a root run. It uses
task events as wake hints and reloads the snapshot as the source of truth, with a
bounded one-second fallback poll for cross-process or missed events. It returns the
authoritative terminal record or the externally suspended `input-required` status.
If it observes an expired deadline before a delayed timer worker, it invokes the
same terminal coordinator.

Adopt this contract as follows:

- CLI streaming and buffered runners await root terminality;
- buffered JSON-RPC execution awaits root terminality;
- SSE starts the same monitor independently of the HTTP connection, so disconnect
  does not cancel or orphan the root;
- Hatchet and other durable workers process the persisted timeout timer without
  holding a segment worker open;
- asynchronous A2A children retain their existing child-token and per-child timeout
  semantics;
- custom runtime drivers require no new completion-handle API.

After `runtimeDriver.waitForIdle()`, reload lifecycle state before accepting an idle
observation. An active root continues waiting even if process-local promise sets are
temporarily empty.

### Terminal cleanup and runner outcome

Run `drainBackgroundTasks` only after terminality. Reconcile ownership and enumerate
active work both before and after runtime-driver idle waiting and again after the
cleanup grace delay. The final report and timeout decision must use this last
observation rather than counts captured before the delay.

Terminalize legacy pending effects found under a terminal owner and request abort
best-effort. If cleanup remains incomplete, preserve the authoritative task status
and attach a structured `BackgroundTaskDrainReport`. A completed task exits zero;
a failed or canceled task exits nonzero. Cleanup diagnostics never call
`taskCtx.fail` or replace terminal status.

Add low-cardinality metrics for terminal-wait outcome, terminal-claim disposition,
active-run timeout winners, recovered terminal publication, lifecycle-aware idle
rejection, and cleanup classification.

## Required Tests

### Deterministic runner tests

- `startTask()` returns `await_child`; the child completes, the root performs more
  turns, and starts another child after a brief idle gap. Assert the runner waits
  through the gap and publishes the root's eventual result.
- Repeat with nested child -> tool execution where the next tool registers near a
  drain poll/grace boundary.
- Keep the root active longer than the terminal cleanup timeout but shorter than
  the active-run deadline. Assert no `BackgroundTaskDrainError`.
- Expire the active-run deadline. Assert the root is durably canceled with
  a typed timeout reason, all effects are detached, and the streamed terminal
  status preserves that reason.
- Return `input-required` and assert the status is published without timeout
  cancellation or terminal cleanup.
- Force completion and timeout to race in both orders. Assert one lifecycle claim,
  one matching terminal event/outbox status, and no contradictory late publication.
- Race manual cancellation with timeout and retain the first committed reason.
- Commit a terminal snapshot, suppress event/outbox publication, restart, and
  republish the deterministic terminal status exactly once.
- Commit the root deadline, suppress timer scheduling, restart, and recreate/fire
  the idempotent timeout timer.
- Use a large result/artifact and verify the bounded terminal record does not copy
  its body into working memory or exceed the snapshot cap.
- Disconnect an SSE client while the root is active and verify the independent
  lifecycle monitor reaches the same authoritative outcome.
- Settle cleanup work during the final grace interval and assert the recomputed drain
  report contains no stale active registration.
- Complete the root with a detached provider still settling. Assert the root
  result remains authoritative and cleanup diagnostics do not replace it.

### Real PostgreSQL integration test

Run a multi-stage root that sequentially starts several children and MCP-like
tools with deliberate idle handoff gaps. Use independent SQL sessions/runtime
workers and assert:

1. the root remains active across every gap;
2. no active-graph drain error is published;
3. exactly one authoritative terminal root result is persisted and streamed;
4. no pending child, tool, or timer remains and no outbox or driver run remains in
   an active/unpublished state afterward;
5. active-run timeout, when tested, atomically terminalizes the root before drain.

### Host acceptance

On a clean SQL substrate, run:

```bash
yarn run:testscenario FIX-S17 --site-config-only
```

Acceptance requires an authoritative SiteConfig result or an authoritative typed
host timeout. It must not fail through background drain while the durable root is
active, and the database must contain no active or pending work for the root after
the process exits.

## Compatibility Requirements

- Preserve existing runner CLI and agent APIs by default.
- Preserve custom runtime drivers and backends.
- Keep existing terminal cleanup timeout configuration compatible.
- A new active-run timeout option may be additive, but manifest/runtime latency
  budgets should remain the default source where already defined.
- Do not solve this by increasing the drain timeout, suppressing drain errors, or
  treating active work as detached.

## Implementation Verification

Implemented on 2026-07-18. The runner now observes durable root lifecycle state,
uses separate active-run and terminal-cleanup deadlines, preserves the committed
terminal result during cleanup, and persists/reconciles `task_run_timeout` timers
for both in-process SQL and Hatchet timer workers.

Verification completed:

- full monorepo build: 20/20 packages;
- full test suite: 208 suites passed, 1,275 tests passed, 88 skipped;
- focused runtime/terminal/timeout tests: 79 tests passed;
- fresh-PostgreSQL `FIX-S17 --site-config-only` crossed all former idle/drain
  failure boundaries and durably reached one `completed` root terminal claim;
- the completed root retained zero pending children and zero pending tools, and its
  deterministic terminal publication record was enqueued;
- no `BackgroundTaskDrainError` or active-root synthetic failure was emitted.

The host scenario validator still exited nonzero because the agent's final payload
returned `NON_JSON_VALUE` (`Canonical JSON accepts JSON-domain values only`). That
failure occurred after the authoritative root completion and is separate from this
runner lifecycle defect; it requires a host payload-construction follow-up.
