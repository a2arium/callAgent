# Bug Report: Concurrent root turns can terminalize from stale empty state

> **Status:** Fixed — implementation and task-ownership acceptance complete; four
> unrelated host content assertions remain outside this framework defect
>
> **Severity:** High. A valid root task can be durably marked failed while a
> concurrent turn for the same task continues and produces a successful result.

## Summary

The SQL-backed streaming runner can execute multiple turns for one root task
concurrently. One turn may read the initial empty mental state, execute a terminal
failure, and win the durable task status while another turn has already consumed
the valid user payload, dispatched children, and later completes successfully.

This produces contradictory terminal state across the runner, task ledger, and
turn ledger. In the reproduced host scenario, the console returned a successful
`get-listing` result with `stopReason: "fetch_error"`, while `agent_runs` persisted
the same root as failed with `NO_CASE_ID`. The apparent fetch error was the stale
turn's terminal result delivered into the still-running branch.

## Environment

- CallAgent branch: `hatchet`
- CallAgent commit: `f5b2b0a fix: await durable root terminality in streaming runner`
- Host: `/Users/maximantonov/Work/_lab/itupdated`
- Host commit: `3960686 fix: harden site config discovery acceptance`
- Runtime: real SQL-backed in-process streaming runner
- Date reproduced: 2026-07-19

## Reproduction

From the `itupdated` checkout:

```bash
yarn agent-index
yarn run:testscenario FIX-S01 --skip-discovery
```

The scenario passes routing and live static-HTML acquisition. The root runner is
then started with an input containing all three required keys:

```text
[Test Helper] Payload keys: caseId, caseConfig, siteConfig
```

The root `get-listing` task delegates to `scrape-listing`, which delegates to
`fetch-page-router`, which successfully completes `fetch-html`. During that
execution the runner emits:

```json
{
  "ok": false,
  "error": {
    "code": "NO_CASE_ID",
    "message": "No caseId provided",
    "fromAgent": true
  }
}
```

The child chain nevertheless continues. The same root runner later emits:

```json
{
  "ok": true,
  "data": {
    "newListings": [],
    "pagesVisited": 0,
    "stopReason": "fetch_error"
  }
}
```

The parser validation fails because no listings were persisted.

## Durable Evidence

The reproduced root task ID is:

```text
local-task-1784419850377
```

`turn_runs` contains three turns for that one task. Their execution windows and
outcomes overlap:

| Turn | Started | Completed | Transition | Terminal result |
| --- | --- | --- | --- | --- |
| 1 | `21:10:54.455` | `21:10:54.463` | `complete` | `NO_CASE_ID` |
| 2 | `21:10:50.632` | `21:10:54.639` | `await_child` | none |
| 3 | `21:10:54.646` | `21:10:54.654` | `complete` | success |

Turn 2 was active for nearly four seconds before Turn 1 started and terminalized
the task. Turn 3 then ran after the failed terminal claim and completed
successfully.

The corresponding `agent_runs` record is contradictory with the final host
output:

```json
{
  "task_id": "local-task-1784419850377",
  "agent_id": "get-listing",
  "status": "failed",
  "terminal_code": "NO_CASE_ID",
  "terminal_message": "No caseId provided",
  "output_state": "available"
}
```

The child `scrape-listing`, `fetch-page-router`, and `fetch-html` runs all reached
`completed` for this root.

The same failure reproduced in the preceding root task
`local-task-1784419406895`, so it is not a one-off timing anomaly.

## Expected Behavior

1. At most one turn for a task may execute policy/execution against a given
   durable state revision at a time.
2. A wake or inbox delivery racing an active turn must be coalesced or queued; it
   must not start a concurrent stale turn.
3. Once a turn claims terminal task lifecycle, no later turn may continue policy,
   dispatch children, or publish a conflicting successful result.
4. If a successful terminal turn wins first, a stale failure cannot overwrite it.
5. The runner's authoritative terminal output, `agent_runs`, status outbox, and
   `turn_runs` must agree.
6. A child result must be delivered only to the active parent turn/state revision
   that owns its await token.

## Suspected Failure Class

This is an informed host-side diagnosis, not a confirmed framework root cause.

The timestamps indicate that two scheduling paths claimed the same root task:
one processed the real input and awaited a child, while another started from
stale pre-input mental state and evaluated the host policy's `NO_CASE_ID` guard.
The stale turn terminalized durably, but the active child branch was not stopped
and later published another terminal result.

Likely areas to inspect include:

- root inbox wake versus initial runner dispatch;
- per-task turn lease/claim acquisition and renewal;
- turn sequence allocation relative to durable execution ownership;
- terminal lifecycle checks before starting and before committing a turn;
- delivery of terminal child observations after another turn claims terminality;
- `TaskEngine.startTask` and streaming-runner terminal reconciliation introduced
  or exposed by `f5b2b0a`.

The earlier `AgentIndexLoader` warning is not causal. The index contains all 15
host agents, the child agents are identified correctly in `agent_runs`, and the
durable trace proves the failure occurs at the root turn lifecycle.

## Recommended Fix Contract

### Serialize turn ownership durably

Acquire a per-task turn lease/claim with compare-and-set before any perception,
policy, or execution side effect. A second scheduling signal should only record
that another turn is needed; it must not execute concurrently.

The claim must be safe across multiple runtime instances and process restarts,
not only guarded by an in-memory mutex.

### Revalidate before side effects and commit

Immediately before executing provider/child side effects and before committing a
turn outcome, revalidate:

- task lifecycle is active;
- the caller still owns the turn lease;
- the durable state revision matches the revision read by the turn;
- no terminal claim has already won.

A stale turn must exit as superseded without publishing an agent result.

### Make terminal claims authoritative

Terminal claim, task status, result/outbox publication, and turn completion must
form one CAS-linearized outcome. A later stale success or failure may be retained
as diagnostics, but cannot change the task or runner result.

### Coalesce wakes

When inbox data arrives during an owned turn, set a durable rerun-needed flag or
queue the observation for the next sequence. On turn completion, exactly one next
turn may claim it.

## Required Tests

### Deterministic races

- Pause Turn A after it consumes valid root input, then issue a second wake. Prove
  Turn B cannot enter perception/policy until A releases ownership.
- Race initial root dispatch with the first durable inbox notification. Assert one
  turn consumes the payload and no empty-state turn runs.
- Pause an awaiting parent turn, deliver its child result, and concurrently issue
  another wake. Assert exactly one resumed turn.
- Let a terminal failure claim first, then release a stale successful turn. Assert
  no second terminal result, child dispatch, or outbox write.
- Let success claim first, then release stale failure. Assert success remains
  authoritative everywhere.
- Repeat against two independent TaskEngine/runtime instances using PostgreSQL.

### Ledger consistency

For every race, assert:

- no overlapping executing turn leases for the same task;
- monotonic turn sequence and state revision;
- one terminal `agent_runs` state;
- one authoritative terminal outbox result;
- runner output matches `agent_runs` and terminal `turn_runs`;
- zero pending children, tools, timers, driver runs, or outbox rows after drain.

### Host acceptance

Run from a clean SQL-backed environment:

```bash
yarn run:testscenario FIX-S01 --skip-discovery
yarn run:testscenario --all --skip-discovery
```

`FIX-S01` must parse and persist at least two listing records. The full parsing
suite must not emit `NO_CASE_ID` for any payload that includes `caseId`, and no
root task may have conflicting failed and successful terminal turns.

## Acceptance Criteria

- The deterministic and real-PostgreSQL races pass.
- `FIX-S01 --skip-discovery` passes repeatedly.
- The full host parsing/router suite no longer shares this `NO_CASE_ID` failure.
- Runner output and durable task/turn records agree for every terminal path.
- Existing single-turn, restart, cancellation, timeout, and detached-branch tests
  remain passing.

---

---

# Fixing Specification: Durable Fenced Task-Turn Ownership

**Architecture status:** accepted. This specification defines one runtime protocol and
one authoritative task-turn coordinator. There is no compatibility router. Development
and test Hatchet histories must be reset before running these workers.

**Implementation status (2026-07-19):** complete. The coordinator, fenced commit and
effect gates, atomic wake admission, SQL storage-time support, dispatch-intent scanners,
single Hatchet workflow names, ownership projection, and observer schema are implemented.
The Hatchet root has no stateful dependencies and routes database, cache, timer, outbox,
recovery, cancellation, and projection work through keyed `aplret.task-state` children;
first-generation reconciliation can reconstruct the deterministic root submission.
Focused core, SQL, Hatchet, and observer suites pass, including a real Hatchet root,
state-child, and segment run against PostgreSQL. The indexed recovery query was verified
on 200,000 production-shaped rows. Five clean sequential FIX-S01 runs and the complete
host suite found no stale terminal, lost wake, CAS, drain, or ownership failure.

During host acceptance, four additional integration gaps were found and fixed before
the final run: the obsolete turn-sequence unique index required an explicit drop-index
migration; flush coalescing could leave an orphan rejected promise; local artifact
thenables needed normalization before Prisma JSON persistence; and in-process async-child
terminal delivery needed to reconstruct the persisted parent link and use the durable
child terminal rather than stale process-local status.

## Product Contract

For each tenant task, at most one unexpired fenced claim may authorize agent execution
or task-owned writes. Wakes are durable demand, not permission to execute. A wake is
accepted exactly once, increments the requested generation exactly once, and is either
owned immediately or left runnable for recovery.

A terminal result is authoritative only after its snapshot mutation wins arbitration.
A stale attempt may finish remote provider work, but it cannot publish task state,
effects, events, cache output, parent completion, or observer terminal status.

The framework uses only these Hatchet workflow names:

- `aplret.task`: durable root and segment sequencing authority;
- `aplret.segment`: one admission attempt and, if claimed, one agent turn;
- `aplret.task-state`: idempotent state, projection, and recovery operations.

The obsolete Hatchet protocol configuration variable is rejected at startup. Schema
versions validate stored data and API responses; they never select runtime behavior.

## Authoritative Coordinator

The task snapshot contains:

```ts
type TaskTurnCoordinatorState = {
  schemaVersion: 1;
  nextFence: string;
  nextTurnSeq: number;
  requestedGeneration: string;
  completedGeneration: string;
  active?: {
    claimId: string;
    fence: string;
    ownerId: string;
    requestKey: string;
    claimedGeneration: string;
    turnSeq: number;
    phase: 'claimed' | 'executing' | 'committing';
    runtimeSurface: 'direct' | 'in_process' | 'hatchet';
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
  };
  dispatchIntent?: {
    generation: string;
    deliveryKey: string;
    runtimeSurface: 'direct' | 'in_process' | 'hatchet';
    createdAt: string;
    enqueuedAt?: string;
  };
};
```

All decimal counters are losslessly parsed and monotonic. Timestamps, active-claim
relationships, dispatch generation, and schema version are strictly validated.
Malformed or missing initialized state throws the sanitized
`TASK_TURN_COORDINATOR_INVALID` error. Coordinator initialization happens only in the
atomic root-start or child-bootstrap mutation.

Every mutation obtains storage time on every CAS attempt. SQL creation, renewal,
expiry, takeover, flush, effect registration, and commit never use worker time.
Configured production defaults are a 120-second lease, 20-second heartbeat,
40-second renewal safety window, and 10-second takeover grace, with startup validation.

The expiry boundary is inclusive: `storageNow >= expiresAt` is expired. An expired
claim cannot renew, flush, register effects, or commit. During takeover grace the
request remains queued until the earliest safe takeover time. A logical acquisition
generates its proposed claim ID once and reuses it across CAS retries.

## Atomic Wake Admission

Every start, input, tool, child, timer, event, and conversation wake enters one pure
snapshot reconciliation mutation. That mutation:

1. rejects duplicate processed keys without advancing demand;
2. stages the complete payload and processed key;
3. increments `requestedGeneration` once;
4. atomically acquires an eligible claim or records a deterministic dispatch intent.

Initial input is persisted even when lineage metadata already exists. Prepared runtime
objects do not carry an authoritative snapshot; execution rebuilds mental state and
input from the successful claim snapshot.

Child and tool terminal coordinators stage their one terminal observation and advance
the parent generation in the same winning CAS. Later runtime publication is only a
deterministic nudge. Losing or duplicate workers do not advance demand.

Incoming wakes always reach durable admission. Process-local keyed scheduling is only a
contention optimization and never serializes wake acceptance behind a running body.
Conversation delivery stages a wake and does not reenter the same task body.

## Claim Execution and Arbitration

Claim completion has three explicit paths:

- `commitTaskTurn` validates the live fence, merges only turn-owned state, advances
  the claimed generation, releases ownership, and creates the next dispatch intent;
- `releaseUnstartedClaim` is legal only before agent code starts and leaves demand
  runnable;
- uncertain persistence after agent execution stops renewal and leaves the lease for
  expiry and takeover. It never declares the generation complete or immediately
  reruns the body.

Unexpected agent errors are committed as failed outcomes when the claim is still
authoritative. Otherwise the lease is left uncertain for recovery.

`TaskExecutor` returns a structured commit result with disposition, committed
snapshot/version, authoritative boundary and status, terminal record, and
`scheduleNext`. Dispositions have these merge rules:

- `committed`: merge the current turn and publish its durable result;
- `matching_terminal`: reuse and idempotently republish the existing winner;
- `competing_terminal` or `superseded`: merge no local mental state, inbox, pending
  work, metadata, output, artifacts, or result.

Terminal records include claim ID, fence, generation, and logical turn sequence.
`TurnRunner` consumes the commit result directly; it never reloads and combines it
with a stale local outcome. Unknown coordinator or disposition state is an internal
protocol failure, never a synthetic successful application result.

Only the durable terminal winner may drive runner output, parent notification, cache
publication, status outbox, relational projections, and final events. Terminal tasks
set completed generation equal to requested generation and cannot appear runnable.

## Fenced Writes and Effects

One fenced flush implementation serves normal turn persistence, explicit context
flush, mental-state flush, legacy handlers, progress/status writes, and pre-effect
flushes. Every CAS attempt validates claim ID, fence, lifecycle, and unexpired lease
against storage time.

Tool, child, group, timer, CallLLM, and provider registrations require the same exact
claim. Recovery writes require a private internal-system capability; public context
APIs cannot omit ownership. Claim loss or inability to renew before the safety window
aborts cooperative provider work. Physical provider execution may finish after
takeover, but its delivery rights are revoked.

CAS mutators transform snapshots only. Artifact preparation uses deterministic keys
outside the mutator and publication is an idempotent post-commit projection.
Superseded artifacts cannot become authoritative.

## Event Projection

`turn.started` is appended only after acquisition and includes attempt identity,
claim, fence, generation, and logical turn sequence. Trace data is buffered while the
agent runs.

After arbitration:

- `turn.completed` is appended only for the committed winner;
- `turn.superseded` records a losing attempt without projecting its outcome;
- append failures are repairable projection failures and never invalidate a committed
  snapshot.

Events, outbox messages, and runtime nudges use deterministic idempotency keys.

## Dispatch Recovery

In-memory and SQL stores implement keyset-paginated
`listRunnableTurnRequests()`. SQL scans active snapshots with dispatch intents through
a partial JSON-expression index. Reconciliation uses batches of 100, concurrency 4, a
jittered five-second interval, and exponential error backoff.

In-process recovery schedules the deterministic delivery key. Hatchet recovery emits
`task-turn-available:<tenant-task-key>` to the existing durable root. A start intent
whose root was never accepted reconstructs the same deterministic root submission.
Recovery never invokes a standalone segment.

The per-task 25-millisecond polling loop is removed. Idle detection remains false while
a claim, runnable generation, unprocessed dispatch intent, or relevant recovery
operation exists. Production enablement requires a representative
`EXPLAIN (ANALYZE, BUFFERS)` proving index-backed scanning.

## Hatchet Runtime

`aplret.task` is the sole durable root. Its concurrency key is the unambiguous
tenant-task key with `maxRuns: 1` and `CANCEL_NEWEST`; snapshot fencing remains the
authority if duplicate roots exist.

The root performs only Hatchet-recorded branching:

- `ctx.runChild`;
- `ctx.waitForEvent`;
- durable sleep;
- cancellation and timeout handling.

Snapshot reads, boundary reconstruction, result-cache access, outbox lookup,
DriverRun updates, terminal projection, parent notification, and timer access execute
through deterministic `aplret.task-state` children or existing keyed child
operations.

Root transitions are:

| Segment disposition | Root action |
| --- | --- |
| `executed` | reload authoritative state; wait, continue, or project its terminal |
| `queued` | wait for the availability event or bounded durable sleep, reload, retry |
| `matching_replay` | reload authoritative state; never trust a cached boundary alone |
| `superseded` | record diagnostics, reload, and continue |
| `terminal_replay` | idempotently project and return the durable terminal winner |
| unknown | record runtime failure, reload/recover, never terminalize the application |

Attempt ordinal and logical turn sequence are separate. Child keys use root run key,
attempt ordinal, and generation; queued attempts have no logical turn sequence. The
root key is `<tenant-task-key>:root:1`. Replacement-root takeover is deferred unless
real Hatchet tests prove accepted roots can be stranded.

## Observer and Relational Projection

The run-graph response uses `schemaVersion: 2` and contains a sanitized coordination
view with state, health, observed time, requested/completed generations, live claim,
dispatch intent, and explicit issues. Server time derives lease health; browser time is
display-only.

Turn attempts include stable attempt key/sequence, optional logical turn sequence,
disposition, claim, fence, claimed generation, and
`authoritativeTerminal`. Semantic turn uniqueness is
`(tenantId, taskId, attemptKey)`; logical turn sequence is nullable and indexed.
Executed logical turns and runtime attempts are counted separately.

Bridge and semantic graphs expose identical ownership fields. Semantic enrichment
always reads the current coordinator before returning. Summary displays coordination
health and safe identifiers. Turns display Executed, Queued, Replay, Superseded, and
Terminal replay badges and “Attempt N · Turn M” where available. Queued and
superseded attempts are muted diagnostics, not failures.

No observer response exposes input, mental state, inbox payloads, tool/provider
arguments or results, credentials, or raw snapshots. The observer remains read-only.

## Observability

Low-cardinality metrics cover claim acquisition/takeover/supersession, renewal
success/loss/uncertainty, commit disposition, queued/coalesced wakes, recovery count
and lag, Hatchet duplicate roots, and observer projection mismatch.

Operational documentation explains leases and fences, generation coalescing,
authoritative terminal publication, safe root nudging, projection repair, the fact
that remote provider work can duplicate after takeover, and the development/test
Hatchet reset procedure.

## Required Tests

### Coordinator and races

- strict state parser failures and missing initialization;
- empty and metadata-only initial start;
- concurrent wakes with one agent entrant;
- input/start race without an empty turn;
- exact expiry, grace, renewal loss, and increasing fences;
- every flush and effect API under an expired or replaced claim;
- agent failure and persistence uncertainty;
- competing success, failure, cancellation, and timeout terminals;
- post-arbitration events and suppressed superseded traces.

### PostgreSQL and recovery

- two independent engines racing the same version;
- SQL time under deliberately skewed worker clocks, including first creation;
- restarts after wake staging, claim, terminal commit, and enqueue-before-mark;
- overlapping reconcilers and deterministic deduplication;
- partial-index query plan verification;
- heartbeat p95 below 100 ms and p99 below 250 ms;
- conflict rate below 1% steady state and 5% burst;
- recovery p99 below 30 seconds.

### Hatchet

Use a supported real Hatchet engine and PostgreSQL in addition to unit mocks. Cover
duplicate root submission, every segment disposition, worker death before execution,
during provider work, and after commit, root replay purity, lost nudges, engine/database
restart, network partition, eviction, timeout, and operator cancellation. Assert no
obsolete configuration input, dual workflow, or version-suffixed workflow remains.

### Observer

Verify bridge/semantic parity, live semantic enrichment, multiple attempts for one
logical turn, authoritative terminal marking, all coordination health states, every
disposition badge, and strict payload/redaction budgets.

## Verification and Acceptance

Run focused core, SQL, Hatchet, and observer suites, followed by:

```bash
yarn workspace @a2arium/operator-viewer test
yarn workspace @a2arium/operator-viewer build
yarn workspace @a2arium/callagent-driver-hatchet test --runInBand
CALLAGENT_TEST_REAL_HATCHET=1 yarn workspace @a2arium/callagent-driver-hatchet test --runInBand --forceExit
yarn build
yarn test
```

From a fresh SQL database and reset Hatchet namespace:

```bash
yarn run:testscenario FIX-S01 --skip-discovery  # five sequential runs
yarn run:testscenario --all --skip-discovery
```

Acceptance requires no overlapping agent execution, no expired or stale write/effect,
no lost wake, one durable terminal winner across all projections, no active pending
work after terminal drain, and complete observer explanation of ownership and attempts.
All five FIX-S01 runs must persist at least two listings and must retain supplied
`caseId` values.

## Acceptance Evidence (2026-07-19)

- Shared and isolated Hatchet stacks reported ready; the real-Hatchet integration ran
  `aplret.task` through keyed `aplret.task-state` and `aplret.segment` successfully,
  including worker-unavailable/restart recovery (2 tests passed).
- The SQL dispatch-intent scan used `wm_sessions_turn_dispatch_intent_idx` on 200,000
  production-shaped rows, returned its 100-row page without a sequential scan, and
  completed in 67.508 ms.
- Focused coordinator/runtime/Hatchet/observer suites, the monorepo build, and the full
  repository test run passed (212 suites and 1,304 tests; separately gated suites were
  skipped by their normal environment guards).
- Five sequential `FIX-S01 --skip-discovery` runs against a fresh migrated database
  passed and persisted three fresh listings each.
- `yarn run:testscenario --all --skip-discovery` passed 37 of 41 scenarios. FIX-S32 and
  FIX-S36 failed host HTML-marker assertions; FIX-S33 and FIX-S37 produced no expected
  listings. All four completed without a framework ownership, Hatchet, CAS, drain, or
  stale-terminal error and are retained as separate host-content acceptance findings.
- The final SQL ledger contained zero active claims, runnable generations, dispatch
  intents, terminal tasks with active children/tools/tasks, `NO_CASE_ID` turns, or tasks
  with more than one authoritative terminal attempt.

## Delivery Order and Rollout

1. finish coordinator strictness, atomic wake admission, commit/release semantics, and
   fenced writes;
2. complete indexed recovery and remove local polling/authoritative queues;
3. make the Hatchet root pure and add `aplret.task-state`;
4. complete relational and observer ownership projections;
5. pass PostgreSQL, real-Hatchet, capacity, and host acceptance;
6. deploy schema, server, workers, and observer as one coordinated release.

There is no mixed-worker compatibility window. Development and staging histories may
be reset. Rollback is supported only before new coordinator snapshots execute;
afterward the complete new contract must be restored together. Exactly-once remote
provider execution is out of scope, but exactly one durable state, effect-delivery,
and result winner is required.
