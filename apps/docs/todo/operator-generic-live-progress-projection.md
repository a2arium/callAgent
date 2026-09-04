# Change Request: Generic live-progress projection for long-running agents

> **Status:** Implemented.
>
> **Priority:** High for operational visibility. This does not change agent
> execution correctness, but prevents a healthy, checkpointing agent from looking
> frozen while it performs substantial work inside one provider segment.

## Summary

Add a small, durable, agent-supplied live-progress projection to CallAgent and
display it in Operator. This is a framework capability for **all** agent kinds;
ANAC CIG/SmartCIG is only the incident that exposed the gap.

Today, Hatchet accurately shows whether a durable provider segment is running.
That is not enough to explain what an agent has durably completed when one segment
contains many bounded internal units. The UI may therefore show an active segment
with a zero or unchanged turn count for a long time, even while the agent is
committing checkpoints correctly.

The new contract must show a compact, safe, truthful answer to:

```text
What is this run doing now, what was its last durable milestone, and when did it
last make progress?
```

It must not expose raw events, artifact contents, semantic-memory contents, source
rows, secrets, or private agent implementation details.

## Why this is generic

The same execution shape occurs in importers, crawlers, migration agents, batch
reconciliation jobs, research agents, build/setup agents, and any agent that
performs many internal units within a single Hatchet segment. Provider lifecycle
and agent-domain progress are separate dimensions:

```text
Provider: segment is alive / cancelled / terminal
Agent:    phase, durable checkpoint, completed units, next bounded unit
```

No ANAC schema, CSV concept, or importer-specific storage belongs in the runtime
contract. An agent which does not opt in retains its current behaviour and is
shown as working without a reported progress summary.

## Production example

During CIG run `anac-cig-importer-1788526607259-563f6a76`, the importer advanced
through twelve completed resources and entered `SPOOL_REPLAY`. Its durable
checkpoint and family lease were fresh, but Operator primarily showed the outer
Hatchet root/segment. The visible turn count did not express the completed bounded
units, making normal progress look suspicious.

The existing report
[`operator-projection-collapses-internal-aplret-turns.md`](./operator-projection-collapses-internal-aplret-turns.md)
remains valid: Operator must also preserve detailed cognitive turns where such
traces exist. This request is complementary. A compact live-progress snapshot is
needed even for agents that do not produce useful cognitive traces and must be
inexpensive enough for every active run.

## Public author contract

Progress remains one coherent `TaskContext` capability:

```ts
type RunProgressState = 'working' | 'waiting' | 'blocked' | 'retrying';

type RunProgressUnit = {
  key: string;
  completed: number;
  total?: number;
  label?: string;
};

type RunProgressSnapshot = {
  schemaVersion: 'run-progress-v1';
  phase: string;
  state: RunProgressState;
  summary?: string;
  units?: RunProgressUnit[];
  metrics?: Record<string, number>;
  next?: string;
  checkpoint?: {
    committedAt: string;
    version?: string;
  };
};

type RunProgressReportResult =
  | { status: 'accepted'; revision: string; reportedAt: string }
  | { status: 'coalesced'; revision: string; reportedAt: string }
  | {
      status: 'skipped';
      code:
        | 'RUN_PROGRESS_DISABLED'
        | 'RUN_PROGRESS_UNAVAILABLE'
        | 'RUN_PROGRESS_RATE_LIMITED';
    }
  | {
      status: 'rejected';
      code:
        | 'RUN_PROGRESS_INVALID'
        | 'RUN_PROGRESS_FENCE_LOST'
        | 'RUN_PROGRESS_TERMINAL';
      message: string;
    };

type TaskProgress = {
  (pct: number, message?: string): void;
  (status: TaskStatus): void;
  report?: (snapshot: RunProgressSnapshot) => Promise<RunProgressReportResult>;
};

interface TaskContext {
  progress: TaskProgress;
}
```

The two forms have deliberately different guarantees:

```ts
// Existing transient A2A status. It is not a durable checkpoint projection.
ctx.progress(35, 'Downloading resources');

// New durable, task-scoped Operator projection.
const result = await ctx.progress.report?.({
  schemaVersion: 'run-progress-v1',
  phase: 'spool-replay',
  state: 'working',
  summary: 'Replaying validated chunks',
  units: [
    { key: 'chunks', label: 'Chunks', completed: 6, total: 24 },
    { key: 'resources', label: 'Resources', completed: 12 },
  ],
  metrics: { retries: 2, queuedPartitions: 4 },
  next: 'Replay chunk 7',
  checkpoint: {
    committedAt: '2026-09-04T12:30:00.000Z',
    version: 'checkpoint-12',
  },
});
```

Do not add a top-level `ctx.report()` or `ctx.reportProgress()`. A generic report
method would become an unstructured telemetry channel, while a second progress
method would leave authors unsure which one to use. `ctx.progress.report()` keeps
transient and durable progress under one discoverable namespace without changing
the behaviour of existing calls.

### Mandatory and optional fields

The report itself requires:

- `schemaVersion`, fixed to `run-progress-v1`;
- `phase`, a stable machine-friendly phase identifier; and
- `state`, so Operator never infers domain progress state from provider state.

All other top-level fields are optional. Within each `units` entry, `key` and
`completed` are required; `label` and `total` are optional. When `checkpoint` is
present, `committedAt` is required and `version` is optional.

Each report is a complete replacement snapshot. Omitted optional fields are
cleared. An agent that has a prior checkpoint and still wants it displayed must
include that checkpoint and its associated unit values in its next report.

### Authoring rules

- Call `ctx.progress.report()` from the Execution/effect boundary, never from
  Attention, Perception, Learning, Policy, Shield, or Transition.
- Report completed units only **after** the agent's authoritative domain
  checkpoint commits. The generic runtime cannot prove that an arbitrary external
  database transaction committed; this is an agent-author contract.
- A current phase with no completed units may be reported before the first
  checkpoint. Such a report describes current work, not a recovery guarantee.
- Inspect the returned result when progress reporting is operationally important.
  Progress unavailability must never be mistaken for successful checkpointing.
- Progress is a display projection. It does not control retries, scheduling,
  cancellation, leases, terminal status, or side-effect ownership.

## Validation, bounds, and privacy

The runtime validates reports before persistence. Validation returns
`RUN_PROGRESS_INVALID`; it does not silently truncate or reinterpret values.

V1 limits are fixed framework contract values:

- the UTF-8 JSON encoding is at most 8 KiB;
- `phase` is 1–64 characters and matches a documented lowercase identifier
  pattern such as `spool-replay`;
- `summary` and `next` are non-empty when supplied and at most 256 characters;
- `units` contains at most 8 entries with unique, bounded identifier keys;
- `completed` and `total` are non-negative safe integers, and `completed` cannot
  exceed `total` when a total is supplied;
- `label` is non-empty when supplied and at most 80 characters;
- `metrics` contains at most 16 bounded identifier keys and finite numeric values;
- `checkpoint.committedAt` is a valid ISO-8601 timestamp and `version` is at most
  128 characters; and
- unknown fields, arbitrary nested objects, arrays outside `units`, binary values,
  functions, `NaN`, and infinities are rejected.

The schema makes large or structurally unsafe payloads impossible, but a runtime
cannot reliably determine whether an arbitrary short string contains sensitive
business data. Agent authors remain responsible for keeping `phase`, `summary`,
labels, metric keys, and `next` operationally safe. They must not include raw rows,
artifact IDs or bodies, memory values, request bodies, credentials, tokens, local
paths, embedded-credential URLs, stack traces, or CallKG payloads. Operator escapes
all text and never interprets it as markup.

## Persistence and ownership

Store one latest record per **agent task**, keyed by `(tenant_id, task_id)`, with
`root_task_id` indexed for bounded root/descendant lookup. Root-only storage is
incorrect because child agents also need progress and must not overwrite their
parent's snapshot.

Add a `run_progress` operational projection with:

- tenant, task, root-task, and agent identity;
- validated snapshot JSON and schema version;
- a server-assigned monotonic revision;
- current `claim_id`, turn fence, claimed generation, and logical `turn_seq`;
- server-owned `reported_at` and `updated_at` timestamps; and
- optional terminal state and terminal timestamp.

Do not add progress history in V1. The latest record answers the operational
question, remains bounded, and avoids creating another event stream. If a concrete
diagnostic need emerges later, history requires a separate retention and paging
design.

### Atomic fencing rules

The durable store operation validates and writes progress in one database
transaction:

```text
agent report
    |
    v
validate bounded snapshot
    |
    v
lock/read authoritative task snapshot
    |
    +-- task terminal ------------------> RUN_PROGRESS_TERMINAL
    +-- active claim does not match ----> RUN_PROGRESS_FENCE_LOST
    |
    v
compare current run_progress row
    |
    +-- identical snapshot ------------> coalesced
    +-- noisy report inside limit -----> RUN_PROGRESS_RATE_LIMITED
    |
    v
increment server revision and upsert
```

The reporter derives tenant, task, root-task, agent, claim, generation, fence, and
turn identity from the active runtime context. Agents cannot provide or override
them. The SQL implementation re-reads the authoritative task coordinator while
holding the transaction; a prior read followed by a separate upsert is not safe,
because a superseded worker could write between those operations.

A legitimate takeover with a higher active fence may update the row and receives
the next server revision. A stale or cancelled execution cannot write even when no
new owner has reported yet. The existing snapshot coordinator remains ownership
truth; `run_progress` is never used to grant execution authority.

The SQL session-store port owns the atomic operation because it can inspect the
working-memory snapshot and update `run_progress` in the same transaction. Stores
that cannot provide this capability leave `ctx.progress.report` undefined. Testing
and standalone contexts remain source-compatible.

Identical reports are coalesced without advancing revision. Non-identical reports
are limited to one accepted write per task per second by default; a phase or state
change bypasses that interval. A rate-limited call returns an explicit skipped
result. Storage outages return `RUN_PROGRESS_UNAVAILABLE`, emit sanitized logs and
metrics, and do not fail the agent's work.

## Recovery, terminality, and retention

1. Process restart or provider redelivery retains the latest valid snapshot until
   the current fenced execution reports a replacement.
2. The resumed agent is responsible for restoring its domain checkpoint before it
   reports new completed counts. The ANAC adoption test must prove counts do not
   regress after recovery.
3. Task completion, domain failure, explicit cancellation, and provider-terminal
   reconciliation remain authoritative. Progress cannot revive, complete, fail,
   cancel, or change a task lifecycle.
4. Every authoritative terminal path marks the progress record terminal using the
   winning task state and terminal timestamp. That operation is idempotent.
5. Once terminal, `ctx.progress.report()` returns `RUN_PROGRESS_TERMINAL`; a late
   worker cannot replace the last valid snapshot.
6. Operator displays preserved terminal progress as **Last reported progress**,
   never as current activity.
7. `run_progress` follows the same semantic retention policy as its `agent_runs`
   record. Add it to maintenance planning now; it remains preserved while semantic
   run summaries are preserved and must be removed with them if semantic deletion
   is enabled later.

## Read APIs

Use two explicit read paths and keep progress out of run-graph topology:

### Fleet list

Extend each returned `AgentRunListItem` with an optional compact `progress` view.
The semantic list repository fetches progress for the already bounded page using
one tenant-scoped `task_id IN (...)` query. It must never issue one query per row.
Non-adopting and historical runs omit `progress`.

### Task detail

Add:

```http
GET /tasks/:taskId/progress
x-tenant-id: <tenant>
```

The authenticated, tenant-scoped response distinguishes `reported` from
`unreported`. A missing record is a normal `200` unreported response, not an error.
The reported view includes the validated snapshot, server revision, report time,
and terminal metadata, but never exposes claim IDs, fences, generations, or other
ownership internals.

Operator polls this endpoint every five seconds while the selected task is active
and stops after authoritative terminality. The existing fleet query already polls
every five seconds. Neither surface reads artifacts, memory, raw events, or Hatchet
history to derive progress. Progress updates do not rebuild or relayout the run
graph.

## Operator presentation

Provider lifecycle and agent progress must always be presented as separate facts.

### Run detail

Place an always-visible **Live progress** panel immediately below the sticky run
header and above the graph:

```text
Provider execution
Segment running · 18m

Live progress
Spool replay · Working
██████░░░░░░░░░░░░░░  6 / 24 chunks

Replaying validated chunks
Last checkpoint 9s ago · Next: Replay chunk 7
Retries 2 · Queued partitions 4
```

This information must not be hidden inside an inspector tab.

### Fleet

Add a compact **Progress** column next to Status. It displays the humanized phase,
primary unit count when present, and report age. The data arrives with the existing
paginated fleet request.

```text
Agent           Status      Progress                         Updated
cig-importer    Running     Spool replay · 6/24 chunks      9s ago
researcher      Running     Gathering sources               4s ago
legacy-agent    Running     No progress reported            —
```

### Selected agent inspector

Add Progress to the Summary tab for the selected root or child agent. Fetch only
the selected task's direct progress view. This gives child progress a clear home
without crowding graph nodes.

### Display rules

- Humanize phase identifiers for display: `spool-replay` becomes `Spool replay`.
- Show a progress bar only when both `completed` and `total` exist.
- Without a total, show text such as `12 resources completed`; never estimate a
  percentage.
- The first unit is the primary bar/count. Remaining units and metrics are compact
  secondary values in report order.
- `blocked` and `retrying` use warning styling but do not change the authoritative
  run badge or severity.
- An active run without a snapshot shows
  **Working — agent has not reported progress yet.**
- A sufficiently old active snapshot shows **Last reported 12m ago** with neutral
  warning styling. Staleness alone does not mark the task failed or stuck.
- A terminal task shows **Last reported progress** and never animates or implies
  that work is still active.
- Unknown or malformed server data falls back to the unreported state and records
  a client diagnostic; it never breaks the run page.
- Do not put full progress content into React Flow nodes or trigger graph relayout
  when only progress changes.

## Configuration and observability

`CALLAGENT_RUN_PROGRESS=enabled|disabled` controls durable progress installation.
It defaults to `enabled` when the configured durable session store advertises the
atomic progress capability. Invalid values fail runtime readiness. When disabled
or unsupported, `ctx.progress.report` is absent and Operator uses the explicit
unreported fallback.

The 8 KiB payload limit, collection limits, and one-second write interval are V1
contract defaults rather than workspace-specific tuning knobs. Add configuration
only after production evidence shows a real need.

Record bounded metrics and structured logs for accepted, coalesced, rate-limited,
invalid, fence-lost, terminal, disabled, and unavailable reports; persistence
latency; API latency; and observed progress age. Dimensions must remain low
cardinality and must not contain task IDs, agent-supplied phase/keys, payload text,
or credentials.

## Documentation updates

Documentation is layered instead of adding a standalone progress guide:

- Root `README.md`: one common example contrasting transient `ctx.progress(...)`
  with durable `ctx.progress.report(...)`, linking to the normative contract.
- `packages/core/README.md`: the same concise introduction for npm consumers.
- `apps/docs/1-tutorial_build_your_first_aplret_agent.md`: an optional
  **Report long-running work** step showing checkpoint-then-report.
- `apps/docs/0-aplret_contracts.md`: normative public types, validation, return
  outcomes, Execution-only use, replacement semantics, and checkpoint honesty.
- `apps/docs/17-runtime_streaming_contract.md`: explain that transient progress is
  public A2A status while durable progress is an Operator projection and never a
  lifecycle event.
- `apps/docs/orchestrator-harness/operator-run-graph.md`: storage identity,
  ownership/fencing, terminal preservation, read APIs, and separation from graph
  topology and cognitive turns.
- `apps/docs/orchestrator-harness/specs/operator-viewer.md`: exact Fleet, run-detail,
  and selected-agent presentation plus polling, stale, missing, and terminal states.
- `apps/docs/orchestrator-harness/specs/production-readiness-gates.md`: tenant,
  fencing, bounds, indexing, query-count, restart/redelivery, and load gates.
- `apps/docs/workspaces-and-runtime.md`: deployment switch, default availability,
  database migration, and operational behaviour.
- `apps/docs/callagent-troubleshooting.md`: unreported/stale displays and all stable
  `RUN_PROGRESS_*` outcomes.

Do not copy the full schema into every guide, add progress examples to unrelated
agent docs, or create a new standalone progress document.

## Implementation sequence

1. Add public schemas/types and validation, preserving both existing callable
   `ctx.progress` overloads.
2. Extend the session-store port and SQL implementation with atomic fenced write,
   direct read, bounded page read, and idempotent terminal marking.
3. Add the mirrored Prisma model and one production migration with the unique
   `(tenant_id, task_id)` key and `(tenant_id, root_task_id, updated_at)` index.
4. Bind optional `ctx.progress.report` only when the runtime has the durable store
   capability and an active task-turn claim.
5. Integrate terminal marking with every authoritative local and provider terminal
   convergence path, then include the table in maintenance planning.
6. Extend the fleet projection and add the direct task progress endpoint.
7. Implement the Fleet column, run-detail panel, selected-agent summary, polling,
   and all fallback states without changing graph layout.
8. Update main, authoring, runtime, Operator, workspace, readiness, and
   troubleshooting documentation.
9. Adopt the API in a generic long-running fixture and the ANAC-style importer only
   after framework behaviour is verified.

## Required tests

### Schema and public compatibility

- Minimal and complete valid reports; every missing mandatory field.
- Unknown fields, invalid identifiers, empty/long strings, duplicate units,
  negative/unsafe counts, completed-over-total, non-finite metrics, invalid dates,
  excessive collections, and exact 8 KiB boundaries.
- Existing `ctx.progress(number, message)` and `ctx.progress(TaskStatus)` behaviour
  remains byte-compatible on public runtime streams.
- Existing agent/test contexts compile without defining `progress.report`.

### Durable ownership

- First accepted write, server revision increment, identical coalescing, rate limit,
  and immediate phase/state changes.
- Tenant isolation and same task ID in two tenants.
- Same-fence concurrent writes serialize deterministically.
- Superseded, expired, cancelled, and lease-lost claims cannot write.
- A higher current takeover fence can advance the record after restart.
- The race where an old worker validates immediately before takeover still loses
  because validation and upsert share one transaction.
- Storage outage returns unavailable without failing the agent.

### Recovery and terminal convergence

- Restart retains the previous report before the resumed attempt reports.
- Completion, failure, cancellation, timeout, and reconciled provider failure each
  terminalize progress idempotently.
- Late reports cannot overwrite terminal progress.
- Terminal correction follows the winning durable task terminal without reviving
  progress.
- Retention planning includes `run_progress` with semantic-run policy.

### API and Operator

- Fleet hydration uses at most one additional bounded progress query per page and
  never an N+1 pattern.
- Direct reads are tenant-scoped; unreported is `200`; internal fence data is never
  returned.
- Fleet phase/count/age, run-detail panel, and selected child summary render.
- Missing reporter, stale report, unknown payload, endpoint failure, and terminal
  copy are clear and recoverable.
- Progress-only refresh does not invoke graph layout and polling stops on terminal.
- Multiple units preserve report order; bars appear only with valid totals.

### End-to-end fixtures

- A generic agent performs many checkpointed units inside one provider segment;
  Operator visibly advances before the segment ends.
- ANAC-style adoption reports only after checkpoints; forced process restart
  preserves the prior milestone and the resumed run advances without duplicate or
  regressing counts.
- Detailed cognitive turns and compact progress agree when both are available, but
  either projection remains independently useful.

## Acceptance criteria

1. Any durable agent task, root or child, can opt in through
   `ctx.progress.report()` without domain-specific runtime code.
2. Existing transient `ctx.progress(...)` callers and public stream consumers are
   unchanged.
3. A checkpointing run shows a fresh phase/milestone in Operator within five
   seconds and before its provider segment ends.
4. A non-adopting or unsupported agent is accurately shown as working without
   reported progress.
5. Restart, takeover, cancellation, and terminal races cannot let a stale execution
   overwrite or revive visible progress.
6. Progress storage, writes, reads, and browser rendering remain bounded
   independently of raw event, artifact, memory, and domain-payload volume.
7. Fleet reads do not introduce per-row queries and progress-only updates do not
   relayout the graph.
8. No cross-tenant data, ownership internals, or private checkpoint/artifact
   contents are exposed.
9. Run lifecycle, cognitive-turn counts, scheduling, and side-effect fencing remain
   unchanged.
10. The documented examples, API reference, Operator specification, readiness
    gates, workspace configuration, and troubleshooting guidance match the shipped
    behaviour.

## Non-goals

- Replacing detailed cognitive-turn or logical-segment projection.
- Automatically persisting legacy transient `ctx.progress(...)` calls.
- Proving that an arbitrary external application transaction committed.
- A generic workflow DAG, percent-complete estimator, or domain-specific dashboard.
- Using progress as a scheduling, retry, cancellation, lease, or side-effect
  control channel.
- Reading agent memory, artifacts, raw events, or provider history to infer progress.
- Persisting progress history, high-volume logs, source data, checkpoint payloads,
  raw errors, or arbitrary custom JSON.
- Displaying full progress content inside graph nodes.
