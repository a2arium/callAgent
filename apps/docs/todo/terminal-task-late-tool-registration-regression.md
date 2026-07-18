# Bug Report: Detached task branches can register new auto-executed tools

> **Status:** Implemented in `0ef46ff fix: reject effects from terminal task
> branches`; focused framework verification passed. Clean-database host acceptance
> remains pending because the shared SQL worker queue contains active tasks created
> before the fix.
>
> **Related fix:** `9226703 fix: detach terminal nested tool executions`.
>
> **Severity:** High. A terminated branch can keep a runner alive, lose the
> authoritative host result, and leak durable work into a later runner.

## Summary

The terminal nested-tool fix correctly detaches background tools that are already
registered when `detachTaskBranch()` runs. It does not appear to prevent a stale
or concurrently executing turn from registering a **new** `tool.auto_execute`
operation after its task lifecycle has become detached or terminal.

Fresh host runs reproduced the failure twice. At the end of a long background
drain, the remaining browser tool was only about 90 ms old. Work from the failed
scenario was then visibly resumed by later, independently launched scenario
runners. This violates terminal ownership, durable task isolation, and the stated
contract of commit `9226703`.

## Environment

- CallAgent branch: `hatchet`
- CallAgent commit: `0ef46ff4d8597b875ec80a24bd3aa51a2022e343`
- Relevant earlier commit: `922670310777743c85304ae1d4ffa45478947a9e`
- Host: `/Users/maximantonov/Work/_lab/itupdated`
- Execution: real SQL-backed streaming runner with `browser-use` MCP tools
- Date reproduced: 2026-07-17
- Verification date: 2026-07-18

## Reproduction

From the `itupdated` checkout, build against the CallAgent checkout above and run
the scenarios sequentially:

```bash
yarn run:testscenario FIX-S05 --site-config-only
yarn run:testscenario FIX-S17 --site-config-only
yarn run:testscenario FIX-S19 --site-config-only
```

`FIX-S05` and `FIX-S17` exercise nested discovery child agents that invoke
`mcp:browser-use.navigate_and_extract`. `FIX-S19` is useful for detecting leaked
work from the preceding failed run.

### FIX-S05 observation

The browser child successfully navigated the modal listing and extracted a real
item. One nested operation then reported:

```text
LLMAbortError
code: LLM_ABORTED
cause: task lifecycle detached
```

The execution continued and eventually failed with:

```text
Background task drain incomplete after 327122ms
```

The remaining task was approximately 93 ms old:

```text
kind: tool.auto_execute
toolName: mcp:browser-use.navigate_and_extract
taskId: a2a_a2a_local-task-1_fetch-browser_1784309063532_gzzypimjw
rootTaskId: local-task-1784308721526
```

The runner emitted a final failed status without a SiteConfig result.

### FIX-S17 observation

The heterogeneous detail content was acquired, but the same lifecycle pattern
ended with:

```text
Background task drain incomplete after 438294ms
```

The remaining nested browser tool was approximately 92 ms old and belonged to
root task `local-task-1784309448726`. Again, no authoritative SiteConfig result
was published.

### Cross-run leakage

While the subsequently launched `FIX-S06`, `FIX-S17`, and `FIX-S19` processes were
running, their console output showed browser work for abandoned earlier targets:

- modal cases `501` and `502` from `FIX-S05`
- `heterogeneous-b.html` detail work from `FIX-S17`

Those targets are not part of the later scenario currently being executed. The
observed behavior indicates that durable pending work from a detached branch is
being reconciled or resumed by a later runner.

Host traces are available at:

```text
/Users/maximantonov/Work/_lab/itupdated/src/temp/logs/scenarios/FIX-S05/site-config-discovery-trace.json
/Users/maximantonov/Work/_lab/itupdated/src/temp/logs/scenarios/FIX-S17/site-config-discovery-trace.json
```

The traces contain only the final failed status because the drain exception's
diagnostic metadata is not included in the streamed terminal status. The complete
drain diagnostics were emitted to the scenario console.

## Expected Behavior

Once a task or any ancestor branch is detached, failed, canceled, timed out, or
otherwise terminal:

1. No stale turn may register a new child, tool request, timer, or wake owned by
   that branch.
2. Registration racing terminal detachment must have one atomic winner:
   - registration wins, then detachment durably claims and aborts it; or
   - detachment wins, then registration is rejected without side effects.
3. A rejected registration must not append `task.tool_requested`, add a pending
   tool, invoke the MCP/provider, or enter the in-memory background registry.
4. A late tool result must remain diagnostic and must not resume a detached task.
5. A later runner must never reconcile or execute pending work from the detached
   branch.
6. Runner drain must preserve the authoritative terminal host result.

## Suspected Root Cause

This section is an informed host-side analysis, not a confirmed framework
diagnosis.

`ApiBinder.requestTool` currently performs `tool.dispatch.register` through
`reconcileSnapshotMutation()`. Its mutation calls `ensureTaskLifecycle()` and
`readTaskLifecycle()`, but it unconditionally adds the tool to `pending.tools`
regardless of `lifecycle.state`:

```ts
const lifecycleBase = ensureTaskLifecycle(baseSnap, { taskId: sessionId });
const lifecycle = readTaskLifecycle(lifecycleBase, sessionId)!;
const toolsNow = { ...getPendingTools(lifecycleBase) };
toolsNow[toolToken] = { /* ... */ };
return { kind: 'write', snapshot: setPendingTools(lifecycleBase, toolsNow), value: lifecycle };
```

After that durable write, the code appends `task.tool_requested`, starts
`__autoExecuteTool`, and calls `trackBackgroundTask()`. The tracker initializes
every newly supplied promise with `state: 'active'`; it does not verify the
durable lifecycle state.

Therefore this interleaving appears possible:

```text
turn A is still executing
branch B is durably detached and its currently registered tools are detached
turn A reaches requestTool
requestTool reads lifecycle.state = detached but does not reject it
requestTool persists and starts a new active tool
root drain sees new active work near its deadline
later runtime reconciliation sees durable pending work
```

The approximately 90 ms age of the remaining task after drains lasting several
minutes strongly supports repeated or late registration rather than failure to
abort only the original tool.

Other dispatch paths should be audited for the same check-then-register gap,
including child dispatch, grouped child dispatch, timers, and runtime wake
reconciliation.

## Recommended Fix Contract

### 1. Atomically gate durable registration

Inside the same snapshot CAS mutation that registers a tool or child, require the
owner task and every represented ancestor lifecycle to be active. If the owner or
ancestor is terminal/detached, return a typed non-writing result such as
`TASK_LIFECYCLE_TERMINAL` or `TASK_BRANCH_DETACHED`.

Do not emulate this with a lifecycle read before the CAS mutation; that leaves the
race open.

### 2. Suppress all post-registration effects on rejection

Only after the CAS mutation confirms registration should CallAgent:

- append `task.tool_requested`
- publish the runtime event
- invoke the tool/MCP provider
- add an in-memory background task

The stale caller should receive a terminal-aware result that cannot trigger retry
or continued reasoning in the detached task.

### 3. Make detachment and registration mutually complete

If registration commits first, `detachTaskBranch()` must still discover the new
pending operation and claim it exactly once. If detachment commits first, the
registration CAS must observe terminal lifecycle and perform no write. SQL CAS
conflict retries must re-evaluate lifecycle state rather than replaying a stale
decision.

### 4. Reject recovery of detached work

Runtime startup and inbox/wake reconciliation must check durable lifecycle before
dispatching pending tools or turns. Existing pending entries under a detached
branch should be terminalized as detached, not executed.

### 5. Preserve diagnostics

If background drain still fails, include the structured drain report in the final
failed status metadata. At minimum retain task ID, root ID, tool name, token,
lifecycle state, age, and detach/abort state. This is secondary to preventing the
leak but is needed for durable diagnosis.

## Required Tests

### Deterministic unit and race tests

- Mark a task detached, then call `requestTool`; assert no pending tool, event,
  provider invocation, or background registration.
- Pause tool registration immediately before its CAS, detach the task, then
  release registration; assert rejection with zero effects.
- Commit registration immediately before detachment; assert detachment claims it,
  requests abort once, and drain ignores it.
- Force a working-memory CAS conflict during registration; after retry observes
  detached lifecycle, assert it does not write.
- Repeat the races for a terminal ancestor with an otherwise active child.
- A late completion after rejection or detachment cannot append a resumable inbox
  observation or schedule a turn.

### Recovery tests

- Seed a detached task snapshot containing a legacy pending tool; startup
  reconciliation terminalizes it without invocation.
- Restart between registration and detachment; exactly one terminal claim wins.
- Start a second runner after detachment; it executes no work for the old branch.
- Prove tenant and root-task isolation while reconciling pending operations.

### Real SQL-backed integration test

Use two independent runtime/engine instances against PostgreSQL. Race a nested
browser-like auto-executed tool registration with ancestor detachment. Assert:

1. no active background operation remains for the root;
2. the terminal parent result is preserved;
3. a fresh runner executes no old-branch work;
4. provider invocation occurs at most once, and zero times when detachment wins;
5. no pending tool remains resumable in durable storage.

### Host acceptance

Run sequentially in a clean SQL-backed environment:

```bash
yarn run:testscenario FIX-S05 --site-config-only
yarn run:testscenario FIX-S17 --site-config-only
yarn run:testscenario FIX-S19 --site-config-only
```

Acceptance requires:

- `FIX-S05` and `FIX-S17` reach their authoritative SiteConfig validation result
  without `Background task drain incomplete`;
- no output from an earlier fixture appears in a later scenario process;
- no outer scenario timeout is used as a lifecycle mechanism;
- all CallAgent orchestration, restart, SQL integration, build, and type suites
  pass.

## Compatibility Requirements

- Preserve current agent, tool, MCP, and streaming-runner public APIs by default.
- Do not require hosts to inspect or mutate CallAgent's lifecycle metadata.
- Active tasks retain current dispatch behavior.
- Custom tools and backends that do not support abort remain compatible; durable
  terminal ownership must still prevent late registration and late resume.
- Do not solve this by shortening drain timeouts or by making the host ignore
  active background work.

## Verification After Framework Fix

### Implementation review

Commit `0ef46ff` adds the required framework-owned controls:

- typed `TASK_LIFECYCLE_TERMINAL` rejection;
- CAS-linearized registration through `TaskEffectRegistration`;
- lifecycle gates for tools, children, groups, inputs, and timers;
- lazy owned-effect execution before provider invocation;
- durable token and lifecycle revalidation;
- remote detachment reconciliation and best-effort abort;
- recovery handling and Hatchet non-retryable classification.

The implementation matches the registration/detachment contract in this report.
CallAgent's reported verification passed 20/20 package builds and 1,244 tests
across 204 passing suites, with four suites skipped.

### Host verification result

CallAgent development verification produced these useful results:

- `FIX-S05` reached a terminal `needs_review` result without a runner-drain
  failure. Its remaining failure was the host's expected `success`
  classification versus bounded `CHILD_TIMEOUT` evidence.
- `FIX-S17` preserved its terminal result with `detachedCount: 1` and
  `activeCount: 0`; the run was stopped after the external browser provider
  entered repeated schema-validation retries.

An independent host rerun could not provide clean acceptance evidence. The shared
PostgreSQL queue still contained active `default`-tenant roots created before
`0ef46ff`. A new runner reconciled those old roots globally while running a new
isolated tenant, so old `heterogeneous-b.html` browser work appeared alongside
the isolated `FIX-S05` modal work. A read-only database check confirmed concurrent
updates under both the old `default` tenant and the new verification tenant.

This does not demonstrate a post-fix registration leak: records that were already
durably active before the fix carry no information from which a new worker can
infer operator abandonment. It does mean that changing tenant is insufficient for
host acceptance because the worker reconciles runnable work across tenants.

### Remaining acceptance gate

Repeat the host acceptance sequence against either:

1. a fresh PostgreSQL database/schema with no pre-fix runtime work; or
2. the current database after all pre-fix roots are canceled through a supported
   CallAgent lifecycle operation and the runtime queue is confirmed idle.

Do not delete working-memory rows manually. After establishing the clean
substrate, run `FIX-S05`, `FIX-S17`, and `FIX-S19` sequentially and confirm that
no target from an earlier scenario appears in a later process.
