# Bug Report: Operator projection collapses internal APLRET turns into one segment turn

> **Status:** Open. Reproduced against a real SQL-backed CallAgent runtime on
> 2026-08-13.
>
> **Severity:** High for observability and operational diagnosis. Agent execution
> remains correct, but Observer presents materially false turn counts, timings,
> LLM counts, and cognitive history for multi-turn `continue` segments.

## Summary

CallAgent correctly executes multiple internal APLRET turns inside one durable
segment, and it durably appends a `turn.completed` event for every cognitive turn.
The Operator/Observer projection then collapses all of those events onto the outer
segment claim sequence.

Only the final cognitive event remains associated with the projected turn. Observer
therefore shows one turn with the final turn's module timings even when the agent ran
dozens of cognitive turns for several minutes.

This is not a request to schedule one Hatchet task per APLRET turn. Segment-level
scheduling should remain unchanged. The requirement is to preserve the distinct
cognitive turns inside each segment in the operator read model.

## Reproduction

Host repository:

```text
/Users/maximantonov/Work/_lab/itupdated
```

Affected task:

```text
source-discovery-service-1786617967248-cb1b11f0
```

The loop-mode `source-discovery-service` was run with a 15-page discovery budget.
It performed seed search, page acquisition, page decisions, verification, and
terminal completion inside one uninterrupted segment.

Observer shows one turn. The module timings visible for that turn include:

```text
Learning:  5 ms
Execution: 3 ms
```

Those values belong only to the final terminal cognitive turn, not to the complete
run.

## Durable Evidence

The `agent_runs` record reports:

```text
task_id       source-discovery-service-1786617967248-cb1b11f0
status        completed
duration_ms   181077
turn_count    1
llm_call_count 0
known_cost_usd 0.293259
```

`turn_runs` contains one row:

```text
turn_seq              1
status                completed
duration_ms           180129
transition_kind       complete
boundary_kind         complete
llm_call_count         0
authoritative_terminal true
```

However, `wm_events` contains **37 distinct `turn.completed` events** for the same
task. The penultimate event has:

```json
{
  "turnSeq": 36,
  "logicalTurnSeq": 1,
  "intent": {
    "kind": "internal",
    "data": { "intent": "verify_page" }
  },
  "timings": {
    "totalMs": 5824,
    "learningMs": 15,
    "executionMs": 5809
  },
  "usage": {
    "llmCalls": 3,
    "totalCost": 0.01742355,
    "inputTokens": 13467,
    "outputTokens": 2129
  }
}
```

The final event has:

```json
{
  "turnSeq": 37,
  "logicalTurnSeq": 1,
  "intent": { "kind": "complete" },
  "timings": {
    "totalMs": 8,
    "learningMs": 5,
    "executionMs": 3
  },
  "llmCalls": []
}
```

The event log therefore retained the correct evidence. The defect is in semantic
projection and run-graph grouping, not in APLRET execution or trace capture.

## Root Cause

`loopRunner.ts` projects both identities onto each cognition event:

```ts
turnSeq: trace.turn,
logicalTurnSeq: claim.turnSeq,
```

In this execution:

- `turnSeq` is the actual cognitive APLRET turn: `1..37`;
- `logicalTurnSeq` is the outer durable segment/claim sequence: always `1`.

The Operator code then prefers `logicalTurnSeq`:

```ts
function eventTurnSeq(payload: Record<string, unknown>): number | undefined {
  return numberField(payload, 'logicalTurnSeq') ?? numberField(payload, 'turnSeq');
}
```

`buildTurnRuns()` stores cognition events in a map keyed by that derived sequence:

```ts
cognitionByTurn.set(turnKey(taskId, turnSeq), event);
```

All 37 events use the same key, so later events replace earlier events. The final
terminal event wins.

The event-driven semantic projector also explicitly treats cognition iterations as
diagnostic-only while `turn.attempt_*` owns `turn_runs`. This produces one projected
row per segment attempt rather than one cognitive turn per `turn.completed` event.

Relevant locations:

- `packages/core/src/loop/loopRunner.ts`
  - `appendOperatorTurnTraceProjection()`
- `packages/core/src/operator/runGraph.ts`
  - `eventTurnSeq()`
  - `buildTurnRuns()`
- `packages/core/src/operator/semanticProjection.ts`
  - `turn.completed` handling
  - `upsertEventTurn()` / turn aggregation
- Observer/Operator UI turn detail projection

## Contract Problem

Three different identities are currently conflated:

```text
Agent run
└── Durable segment/claim #1
    ├── Cognitive APLRET turn #1
    ├── Cognitive APLRET turn #2
    ├── ...
    └── Cognitive APLRET turn #37
```

The durable segment is the correct Hatchet scheduling and retry unit. It is not the
same thing as an APLRET cognitive turn.

The event schema and operator model need explicit, non-overloaded fields, for
example:

```ts
type OperatorTurnIdentity = {
  segmentSeq: number;        // durable claim/attempt sequence
  cognitionTurnSeq: number;  // trace.turn within the agent run
  turnId: string;            // unique cognitive trace identity
  claimId?: string;
  attemptKey?: string;
};
```

Names may differ, but one field must never ambiguously represent both the segment
and cognitive turn.

## Expected Behavior

For the reproduced task, Observer should present:

```text
Agent run: 181.077 s
Durable segments: 1
Cognitive APLRET turns: 37
```

Each cognitive turn must retain its own:

- turn sequence and `turnId`;
- intent;
- stage transition;
- Perception/Learning/Policy/Shield/Execution/Transition timings;
- LLM, tool, child, and memory operation counts;
- usage and known cost;
- start/completion timestamps;
- owning segment/claim identity.

The segment should remain visible as execution infrastructure, but its duration must
not be labeled as a cognitive turn duration and the final cognitive timing must not
be presented as the segment aggregate.

Agent-level totals must aggregate all committed cognitive turns:

- `agent_runs.turn_count = 37`;
- LLM call count is the sum across all 37 turns;
- memory operation count is the sum across all 37 turns;
- cost and token totals must use the existing non-duplicating authoritative source;
- superseded segment traces must not inflate committed totals.

## Recommended Fix

### 1. Separate segment and cognitive identities

Emit explicit fields for both identities. Preserve compatibility when reading older
events, but do not prefer a segment sequence over the actual trace turn.

The current `logicalTurnSeq` name is misleading if it carries `claim.turnSeq`.
Rename it for new events or change its meaning with a schema/version boundary.

### 2. Build cognitive turns from `turn.completed`

Group cognitive events by a collision-safe key such as:

```text
(taskId, claimId/segment identity, cognitionTurnSeq, turnId)
```

Use `turnId` as the final unique identity. Do not use only the outer claim sequence.

Associate every cognitive turn with its owning segment instead of replacing the
segment record. The data model may use a separate cognitive-turn table or extend
`turn_runs`, but the public run graph must expose both layers unambiguously.

### 3. Preserve arbitration semantics

Buffered traces are emitted only after segment arbitration as `turn.completed` or
`turn.superseded`. Project committed traces into normal cognitive turns and retain
superseded traces as diagnostic attempts without adding them to authoritative agent
totals.

Duplicate delivery and reconciliation must converge idempotently by durable event or
turn identity.

### 4. Correct aggregates and UI labels

Compute agent turn count and LLM/memory totals from committed cognitive events.
Display segment count and segment duration separately. If only a segment aggregate is
available, label it `segment`, never `turn`.

### 5. Reconcile historical runs

The complete per-turn evidence already exists in `wm_events`. Extend the terminal
projection reconciliation command, or add a bounded idempotent migration command, to
rebuild affected `turn_runs`/agent aggregates from retained events.

Reconciliation must be tenant-scoped, restart-safe, paginated, and safe to rerun.

## Acceptance Criteria

1. A loop that returns `continue` 36 times and `complete` once is shown as one
   segment containing 37 cognitive turns.
2. All 37 turn details are independently inspectable in Observer.
3. The final 8 ms trace is shown only for cognitive turn 37.
4. The segment duration remains approximately 180 seconds and is labeled as a
   segment duration.
5. Agent run `turnCount`, LLM count, token usage, memory operations, and cost reflect
   all committed cognitive turns without double counting.
6. Multiple segments with overlapping local turn counters do not collide.
7. Retried/superseded segments remain visible diagnostically but do not inflate
   authoritative aggregates.
8. In-process and Hatchet drivers produce the same cognitive-turn projection.
9. Duplicate event delivery and repeated reconciliation are idempotent.
10. Existing one-turn, await/resume, child, failure, cancellation, and terminal-race
    projections remain compatible.
11. Reconciliation repairs the reproduced run from its existing 37
    `turn.completed` events without rerunning the agent.

## Required Tests

- Unit: event identity parsing distinguishes segment sequence from cognitive turn.
- Unit: 37 events sharing one claim produce 37 cognitive turns.
- Unit: map/group logic cannot overwrite turns that share a segment.
- Unit: per-turn timings and LLM calls remain attached to their originating turn.
- Unit: committed and superseded buffered traces produce correct authoritative and
  diagnostic totals.
- Integration: SQL projection persists all cognitive turns and correct agent totals.
- Integration: duplicate projection/reconciliation remains idempotent.
- Integration: two durable segments with internal turns preserve segment ownership
  and globally stable ordering.
- UI: Observer renders a segment with expandable cognitive turns and truthful labels.
- Historical drill: reconcile
  `source-discovery-service-1786617967248-cb1b11f0` and verify 37 turns.

## Non-Goals

- Do not change APLRET `continue` semantics.
- Do not introduce one Hatchet round-trip per cognitive turn.
- Do not change the durable segment as the scheduling/retry boundary.
- Do not solve this by showing only aggregate duration while continuing to discard
  per-turn cognition evidence.

