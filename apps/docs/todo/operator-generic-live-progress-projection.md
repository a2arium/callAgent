# Change Request: Generic live-progress projection for long-running agents

> **Status:** Proposed.
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
contract. An agent which does not opt in must retain its current behaviour and be
shown as working without a reported progress summary.

## Production example

During CIG run `anac-cig-importer-1788526607259-563f6a76`, the importer advanced
through twelve completed resources and entered `SPOOL_REPLAY`. Its durable
checkpoint and family lease were fresh, but Operator primarily showed the outer
Hatchet root/segment. The visible turn count did not express the completed bounded
units, making normal progress look suspicious.

The existing report
`operator-projection-collapses-internal-aplret-turns.md` remains valid: Operator
must also preserve detailed cognitive turns where such traces exist. This request
is complementary. A compact live-progress snapshot is needed even for agents that
do not produce useful cognitive traces and must be inexpensive enough for every
active run.

## Proposed runtime contract

Expose an optional progress reporter on `TaskContext`:

```ts
type RunProgressSnapshot = {
  schemaVersion: 'run-progress-v1';
  phase: string;
  summary?: string;
  state?: 'working' | 'waiting' | 'blocked' | 'retrying';
  unit?: {
    completed?: number;
    total?: number;
    label?: string;
  };
  counters?: Record<string, number>;
  next?: string;
  checkpoint?: {
    committedAt: string;
    version?: string;
  };
};

interface TaskContext {
  reportProgress?(snapshot: RunProgressSnapshot): Promise<void>;
}
```

Names may be refined, but these properties are required:

- It is optional and does not affect execution, retries, scheduling, cancellation,
  leases, or external-side-effect ownership.
- It is scoped to the authenticated tenant and active root run. The runtime derives
  provider/segment identity; the agent never supplies another run or tenant ID.
- It is fenced. A superseded, cancelled, or lease-lost execution cannot overwrite a
  newer run's progress. Return a stable `RUN_PROGRESS_FENCE_LOST` result or make a
  documented no-op.
- The agent reports a milestone **after** its own durable checkpoint commits. It may
  describe current transient work, but must not claim a unit completed before its
  recovery boundary has been committed.
- The snapshot is a display projection, not a second source of domain state. The
  agent's existing durable memory/artifacts/checkpoints remain authoritative.

For ANAC, for example, a completed resource or replay partition would report a
committed count, phase, checkpoint timestamp, and next bounded operation. It would
not report CSV rows, artifact IDs, source values, local paths, request bodies, or
CallKG payloads.

## Durability, bounds, and privacy

Store the latest snapshot in CallAgent's durable operational ledger, keyed by
`(tenant_id, root_task_id)`. This is runtime metadata, not semantic memory and not
an artifact. A separate `run_progress` projection table is preferred over inflating
`agent_runs`; retain a bounded history only if needed for operator diagnostics.

Each write includes a monotonic progress sequence/version and the active execution
fence. Last-write-wins is allowed only for a valid newer sequence from the current
execution. The latest committed snapshot survives a process restart, redelivery,
and Operator refresh.

Apply strict limits at the runtime boundary:

- JSON scalars/arrays/maps only; no functions, binary content, or arbitrary objects;
- maximum encoded snapshot size (for example 8 KiB);
- bounded key count, string length, and counter count;
- no artifact bodies, raw logs, raw source rows, credentials, tokens, URLs with
  embedded credentials, filesystem paths, or arbitrary error stacks;
- coalesce identical reports and rate-limit noisy updates per run, while allowing an
  immediate semantic phase change or final snapshot.

The runtime should reject invalid oversized data with a stable validation error.
It must never silently truncate a value in a way that changes its meaning.

On terminal completion, failure, or cancellation, preserve the last valid snapshot
with terminal metadata for the same retention period as the run. A stale snapshot
must be labelled "last reported"; it must never itself imply that a run has failed.

## API and Operator requirements

Expose a tenant-scoped, authenticated compact read model. It may be included in the
existing run-list response and/or supplied by a batch endpoint; it must not require
one request per visible run. A detail endpoint may expose the same latest snapshot.

For an active run, Operator displays:

- provider lifecycle separately from agent progress;
- phase and optional short summary;
- completed/total unit counts and bounded counters where supplied;
- committed checkpoint time and snapshot update time;
- next unit when supplied; and
- a clear fallback: "Working — agent has not reported progress yet."

Operator should refresh a compact active-run projection at a modest bounded cadence
(for example every 5 seconds), updating only changed snapshot versions. It must not
subscribe the browser to unbounded raw event streams, fetch artifacts/memory to
derive status, repeatedly relayout the run graph, or poll once per active card.

The display should make the distinction clear:

```text
Provider segment: running for 18m
Agent progress: SPOOL_REPLAY · 6/24 chunks committed · updated 9s ago
```

## Recovery and lifecycle rules

1. On restart or provider redelivery, retain the last valid snapshot until the
   resumed execution reports a newer one.
2. A terminal provider result still owns run terminalization. Progress reporting
   cannot revive, complete, fail, or cancel a run.
3. Reconciliation may clear an invalid stale owner/fence but must not delete the
   latest safe snapshot simply because the worker restarted.
4. Terminal convergence appends terminal metadata rather than allowing a late active
   reporter to overwrite it.
5. Existing agents are fully compatible without code changes.
6. The feature may be disabled at deployment level only if Operator renders the
   explicit no-progress fallback rather than misleading zero progress.

## Required tests

- Runtime unit tests for validation, size limits, coalescing, ordering, fencing,
  terminal handling, and no-op compatibility when a context has no reporter.
- SQL integration tests for tenant isolation, restart/redelivery, concurrent
  reporters, terminal races, and idempotent reconciliation.
- API tests proving a caller cannot read another tenant's snapshots and bulk reads
  remain bounded with many active runs.
- Operator tests for phase/counter rendering, stale "last reported" copy, missing
  reporter fallback, terminal snapshot display, and efficient refresh without graph
  relayout or raw-event fanout.
- A generic fixture with many internal durable units inside one provider segment.
  Verify that the UI visibly advances before the outer segment ends.
- Adoption fixture for the ANAC-style checkpointing agent: reports occur only after
  durable checkpoints; a restart preserves the prior milestone and a resumed run
  advances it without duplicate or regressing values.
- Regression coverage alongside the existing cognitive-turn projection report so
  detailed traces and compact live progress agree where both are available.

## Acceptance criteria

1. Any agent can opt in through `TaskContext` without ANAC-specific code or schema.
2. A live checkpointing run reports a fresh phase/milestone in Operator within the
   configured bounded refresh interval, before its provider segment ends.
3. A non-adopting agent is accurately shown as working without reported progress.
4. Restart, redelivery, cancellation, and terminal races cannot regress or falsely
   revive the visible progress state.
5. Progress storage and browser traffic remain bounded independently of raw event,
   artifact, or domain-payload volume.
6. No cross-tenant data or private checkpoint/artifact content is exposed.
7. Existing run lifecycle semantics, scheduling, and side-effect fencing are
   unchanged.

## Non-goals

- Replacing the detailed cognitive-turn/segment projection work.
- A generic workflow DAG, percent-complete estimator, or domain-specific dashboard.
- Using Operator progress as a scheduling, retry, cancellation, or side-effect
  control channel.
- Reading agent memory or artifacts from the browser to infer progress.
- Persisting high-volume logs, source data, checkpoint payloads, or raw events in
  the progress projection.
