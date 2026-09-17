# Bug Report: Operator misprojects recovered turn state and disagrees on turn count

> **Status:** Open. Reproduced against the production SQL-backed Hatchet runtime on
> 2026-09-05.
>
> **Severity:** High for operational observability. Execution and durable recovery
> remain healthy, but Operator presents an active recovered turn as paused and gives
> incompatible turn counts in Fleet and the run graph.

> **Implementation update (2026-09-05):** Snapshot-authoritative fence arbitration,
> bounded recovery provenance, separate logical/cognitive counts, projection repair,
> and Operator recovery diagnostics are implemented. The report remains Open until
> the SQL-backed recovery and browser regressions pass.

## Summary

After a controlled CallAgent worker replacement, one logical turn had multiple durable
execution attempts. Operator selected an obsolete paused recovery/dispatch row as the
logical turn's displayed state even though a newer fenced attempt was actively running.

The same task simultaneously showed:

- **Fleet:** `Turns 4`;
- **run graph:** only `Turn 1` and `Turn 2`;
- **Turn 2 card:** `paused`;
- **authoritative current attempt:** running with a newer claim and fence;
- **root task:** running.

The UI is therefore mixing at least two identity layers: logical turns and provider or
claim attempts. This is a generic Operator projection problem, not an ANAC-specific
agent problem.

## Production reproduction

```text
Task: anac-cig-importer-1788615500000-recovery
Agent: anac-cig-importer
Runtime: Hatchet, PostgreSQL-backed CallAgent
Date: 2026-09-05
```

The task was first admitted with an incorrectly shaped input and legitimately completed
logical Turn 1 with `await_input`. The correct `{ "text": "ingest" }` input then started
logical Turn 2. During Turn 2, a controlled worker restart exercised CallAgent's durable
lease-recovery path.

After recovery, Operator rendered the graph as:

```text
Root: Running
├── Turn 1: Awaiting input
└── Turn 2: paused
```

At the same time Fleet rendered:

```text
Status: Running
Progress: Wait batch · 41/1836 batches
Turns: 4
```

## Durable evidence

The SQL projection contained multiple rows associated with the two logical turns:

- logical Turn 1: completed with `boundary_kind = await_input`;
- logical Turn 2: an obsolete executed attempt closed/superseded at fence 2;
- logical Turn 2: paused queued/recovery bookkeeping rows;
- logical Turn 2: the current executed attempt running with a new claim at fence 3.

The current attempt had a later claim ID and strictly higher fence than the obsolete
attempt. The task root remained `running` and had no terminal code.

The durable progress projection independently confirmed active work:

```text
phase: wait-batch
state: waiting
batches: 41 / 1836
summary: ANAC cig publication is in WAIT_BATCH
generation: 7337999b...
```

CallKG had 41 resolved jobs and one non-terminal ingestion being resolved. It reported
zero stuck claims. No duplicate ingestion was created.

## User-visible defects

### 1. Wrong logical-turn state

The graph appears to choose a paused queued/recovery attempt for Turn 2 instead of the
newest authoritative active attempt. A user can reasonably conclude that execution is
paused or stuck when it is actually running and waiting on CallKG.

### 2. Fleet/detail count disagreement

Fleet reports four turns while the graph exposes two. The likely contract mismatch is:

- Fleet counts projected `turn_runs`/attempt rows;
- the graph groups those rows by logical turn sequence;
- neither label tells the user which unit it represents.

Provider deliveries, queued recovery intents, superseded attempts, and replacement
attempts must not inflate a field labeled `Turns` if that field means logical business
turns.

### 3. Recovery history is flattened

The graph needs to show that Turn 2 is the same logical turn recovered onto a replacement
attempt. Rendering only `paused` hides both the current owner and the successful recovery.

## Expected projection contract

Operator should represent the hierarchy explicitly:

```text
Task
├── Logical Turn 1 — awaiting input (completed)
└── Logical Turn 2 — running / waiting on CallKG
    ├── Attempt A — superseded after worker replacement, fence 2
    ├── Recovery dispatch — consumed/completed infrastructure event
    └── Attempt B — active, fence 3
```

For this reproduction:

- Fleet should show `Turns 2` if its column means logical turns.
- The graph should show Turn 2 as `running` or `waiting`, not `paused`.
- Recovery attempts should be available as nested diagnostics without increasing the
  logical-turn count.
- If Fleet intentionally exposes attempts, it must use a separate, accurately named
  field such as `Attempts`, alongside `Turns 2`.

## Recommended fix

### Define identities explicitly

Use distinct stable fields for:

- logical turn sequence;
- claim/execution attempt ID;
- claim fence;
- provider run/delivery ID;
- recovery dispatch ID and disposition.

Do not infer these identities from row count or overload one `turn_seq` field.

### Select the authoritative state deterministically

For each logical turn, derive its displayed state using authoritative precedence:

1. terminal logical-turn result, if one is authoritative;
2. current active owner/claim with the highest valid fence;
3. durable recovery pending/recovering state;
4. waiting/paused boundary only when no newer active attempt exists;
5. historical superseded and consumed dispatch rows as diagnostics only.

A lower-fence or superseded attempt must never override a higher-fence active attempt.
Late provider events from obsolete lineages must not reopen or downgrade the logical
turn.

### Use one aggregate contract across views

Fleet, graph, summary inspector, and API must calculate `turnCount` from the same
authoritative logical-turn identity set. Attempt and recovery-dispatch counts should be
separate metrics.

### Preserve recovery diagnostics

Expose attempts under their logical turn with status, claim ID (safely abbreviated),
fence, worker transition, start/end timestamps, and supersession reason. Infrastructure
attempts should not appear as additional business turns.

### Reconcile existing projections

If the defect is persisted in `agent_runs.turn_count`, add a bounded, tenant-scoped,
idempotent reconciliation that recomputes logical counts and current state from durable
turn/claim events. Avoid a destructive rewrite of immutable history.

## Acceptance criteria

1. A logical turn recovered three times is shown as one turn with three nested attempts.
2. The highest-fence active attempt makes the logical turn `running` even when older
   queued or executed attempts are paused, completed, or superseded.
3. Fleet and run graph show the same logical-turn count.
4. Recovery dispatch rows never inflate `Turns`.
5. A consumed recovery intent cannot remain the visible current state.
6. When no active attempt exists but recovery is staged, the state is `recovering`, not
   generically `paused`.
7. Terminal arbitration remains authoritative and cannot be overwritten by late obsolete
   provider events.
8. Counts and state remain correct after refresh, process restart, and projection replay.
9. In-process and Hatchet runtimes follow the same public projection contract.
10. Existing ordinary await/resume, cancellation, failure, and completed tasks remain
    correctly represented.

## Required tests

- Projection unit test: two logical turns with four or more attempt/dispatch rows produce
  `turnCount = 2`.
- Projection unit test: a fence-3 running attempt wins over a fence-2 superseded attempt
  and paused recovery rows.
- Projection unit test: a pending recovery with no owner renders as `recovering`.
- Projection unit test: a terminal authoritative result wins over all attempts.
- SQL integration test: lease expiry, recovery dispatch, replacement acquisition, and
  progress reporting converge to one logical turn.
- Reconciliation test: replaying the same events is idempotent and does not inflate
  counts.
- API/UI test: Fleet, graph, and Summary inspector agree on state and logical-turn count.
- Browser regression: the reproduced task shape displays two turns, with recovery history
  nested under Turn 2.

## Relationship to existing report

`operator-projection-collapses-internal-aplret-turns.md` covers cognitive APLRET turns
being collapsed into an outer durable segment. This report covers a different axis:
multiple provider/claim/recovery attempts being counted or selected as if they were
logical turns.

Both reports demonstrate that Operator needs explicit presentation of:

```text
task → logical turn/segment → execution attempt → cognitive APLRET turns
```

Fixes should share an identity model, but this recovered-attempt state/count defect can be
tested and corrected independently.

## Non-goals

- Do not change Hatchet scheduling or CallAgent recovery semantics.
- Do not eliminate retained attempt history.
- Do not flatten attempts by deleting superseded evidence.
- Do not add agent-specific UI logic for ANAC importers.
- Do not count progress reports or polling cycles as turns.
