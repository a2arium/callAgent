# Bug Report: Blocking child artifacts expand inside parent working memory

> **Status:** Fixed and verified on 2026-07-22 against the real local PostgreSQL
> schema and self-hosted Hatchet runtime. A production application canary remains
> a deployment step rather than a code-completion blocker.
>
> **Severity:** High. A correctly artifact-backed child result can exceed the
> parent working-memory limit, supersede the parent turn, and cause repeated
> equivalent Hatchet attempts.

## Summary

A child created a large HTML result with `Artifact.create()` and its durable
`task.child_completed` event correctly contained only a compact artifact marker.
When the parent used `sendTaskToAgent(..., { awaitCompletion: true })`, however,
the parent turn attempted to persist four artifact-sized values in its candidate
working-memory snapshot.

The snapshot exceeded the default 2 MiB limit and emitted
`LIMIT_WM_SNAPSHOT_TOO_LARGE` twice. The turn was superseded, after which Hatchet
recorded repeated queued attempts for the same child-completion request key.

This violates the documented artifact contract: MentalState may retain an
artifact handle, and snapshots must persist that handle as a compact marker rather
than materializing or copying the artifact value.

## Resolution

The report is valid. Four framework behaviors combined to produce it:

1. `prepareChildResultForPersistence()` was `async` and returned an
   `ArtifactImpl` unchanged. Because `ArtifactImpl` is thenable, Promise
   resolution assimilated it and loaded the raw artifact value.
2. MentalState, inbox, LLM state, and terminal outcome were prepared in separate
   operations, so each operation had a separate deduplication scope and stored
   the same `LocalArtifact` again.
3. Blocking-child persistence used the prepared result, but the caller-facing
   handle was populated from the original local result. The parent could
   therefore reintroduce `artifact_local.value` into its next snapshot.
4. Artifact storage reused a best-effort cache write that swallowed database
   errors, allowing an unusable durable marker to be returned after a failed
   write.

The fix now:

- projects every durable artifact handle to the existing plain wire shape
  `{ kind, id, mimeType?, estimatedSize? }` without awaiting or loading it;
- prepares all parent-owned snapshot surfaces as one object graph, sharing one
  object-identity deduplication scope;
- publishes one local artifact once and reuses its durable ID everywhere;
- gives blocking callers a hydrated, awaitable view of the same canonical marker
  while keeping its JSON representation bounded;
- treats configured artifact-store failures as durable persistence failures;
- converts deterministic artifact or snapshot-limit failures for claimed turns
  into one authoritative failed terminal and completes the turn claim;
- retries an oversized snapshot with pruning only when pruning can change the
  candidate.

No existing public call signature, artifact marker wire shape, or database
schema was broken. The Hatchet factories gained optional protocol names for
isolated test/canary routing; all production names remain the defaults. Small
inline values remain inline, and no-cache operation retains its bounded-preview
compatibility behavior.

### Verification completed

- Core and memory-engine builds pass.
- Core public type tests pass.
- Artifact projection, snapshot persistence, blocking-child, turn arbitration,
  cache, TurnRunner, and wake-applicator regression suites pass: 60 tests.
- Hatchet driver build and full non-live driver suite pass: 73 tests; the two
  credential-gated live Hatchet tests also pass.
- The production-shaped 600 KiB test aliases one real `Artifact.create()` value
  through MentalState, inbox, LLM state, and terminal outcome; it performs one
  artifact upsert, uses one ID, contains no raw payload, and remains below 2 MiB.
- The same 600 KiB, five-reference case passes against the real PostgreSQL
  schema: one `artifact_store` row, one durable ID, marker-only snapshot, and a
  serialized snapshot below 2 MiB.
- The self-hosted Hatchet live suite passes both normal root/segment/task-state
  execution and durable restart/resume while the production worker remains
  active.

The live Hatchet gate initially exposed an independent test-isolation defect:
the test worker and production worker registered different implementations under
the same global workflow names. The driver now supports one coherent optional
protocol namespace for root, segment, and task-state declarations. The live test
uses unique names and asserts its own `TurnExecutor` handled each segment. Default
production names are unchanged, preserving existing durable histories.

## Environment

- CallAgent branch: `hatchet`
- CallAgent commit reviewed: `e63815d9f14e5bb8f5a57015f854c4574e11287f`
- Host: `/Users/maximantonov/Work/_lab/itupdated`
- Host task: `discover-listing-selectors-1784668343643-895ee0a8`
- Failing parent task: `a2a_discover-listing_fetch-page-route_1784668400041_bj6mur9bc`
- Child task: `a2a_a2a_discover-lis_fetch-html_1784668400365_q52qbwpf5`
- Runtime: real PostgreSQL-backed Hatchet runner
- Reproduced: 2026-07-21

The operator canceled the root task after observing the repeated attempts. The
cancellation is not the cause of the snapshot failure; both snapshot-limit events
preceded it.

## Production Evidence

The child terminal event returned HTML artifact
`e8763133-6d90-4469-ad33-7349e9ec36e4` with an estimated size of 519,187 bytes.
The durable event stored only the expected marker:

```json
{
  "kind": "artifact",
  "id": "e8763133-6d90-4469-ad33-7349e9ec36e4",
  "mimeType": "text/html",
  "estimatedSize": 519187
}
```

The parent then emitted two events:

```json
{
  "code": "LIMIT_WM_SNAPSHOT_TOO_LARGE",
  "taskId": "a2a_discover-listing_fetch-page-route_1784668400041_bj6mur9bc",
  "message": "Working-memory snapshot exceeded the configured size limit.",
  "limitBytes": 2097152,
  "actualBytes": 2236124
}
```

The artifact-store JSON value for this page occupies 555,622 bytes. The rejected
snapshot size decomposes exactly as:

```text
4 * 555,622 + 13,636 = 2,236,124
```

Four identical 555,622-byte artifact-store writes occurred immediately before
the first snapshot-limit event. Additional identical writes occurred during the
failed persistence/retry path.

The preceding page explains why this is size-sensitive rather than universal.
Its artifact-store value was 514,463 bytes, so four copies narrowly remained near
the 2 MiB boundary and the router completed. The slightly larger validation page
crossed the limit.

A control serialization of one hydrated `ArtifactImpl` referenced from four
fields produced only 503 bytes. Correct hydrated-marker serialization therefore
does not explain the rejected size. The failing path is retaining or reintroducing
the local artifact value before snapshot measurement.

After the two size-limit events, the parent emitted `turn.superseded`. Hatchet
then recorded multiple queued `turn.attempt_finished` events with the same request
key:

```text
a2a_discover-listing_fetch-page-route_1784668400041_bj6mur9bc:
child:019f8686-aaf2-7881-ae0f-9fe8637f936d
```

## Host Flow

The child creates one local artifact:

```ts
html: Artifact.create(content, { mimeType: 'text/html' })
```

The parent invokes that child as a blocking child:

```ts
await ctx.sendTaskToAgent('fetch-html', input, {
  awaitCompletion: true,
  timeout
});
```

The router currently aliases the received value as `content` and `html`, and then
as `fetchedContent` and `fetchedHtml`. This is unnecessary host duplication and
will be removed. It should still be harmless when the value is a durable marker:
four marker aliases serialize to hundreds of bytes, not four copies of HTML.

The observed exact four-value expansion indicates that the synchronous child
delivery path exposes or preserves `artifact_local.value` across snapshot
preparation instead of substituting one durable marker everywhere.

## Minimal Framework Reproduction

Add a SQL-backed parent/child integration test with these properties:

1. The child completes with one 600 KiB string wrapped in `Artifact.create()`.
2. The parent invokes the child with `awaitCompletion: true`.
3. The result flows through a normal child observation and Learning stores the
   artifact handle in MentalState.
4. The parent may deliberately alias the same handle four times to prove aliasing
   remains marker-sized.
5. `WM_SNAPSHOT_MAX_BYTES` remains at the default 2 MiB.

The test should assert:

- the artifact payload is stored once;
- every parent snapshot surface contains only `{ kind, id, mimeType,
  estimatedSize }`;
- raw HTML is absent from the parent snapshot and LLM state;
- the snapshot remains well below 2 MiB;
- no `wm.snapshot_limit` event is emitted;
- one child completion advances the parent exactly once;
- the parent reaches one authoritative terminal result.

Run the same test with `awaitCompletion: false` as a compatibility control. Both
modes must preserve the same artifact identity and bounded snapshot behavior.

## Expected Framework Contract

### Durable marker substitution

Before a child result can enter any parent-owned persistence surface, recursively
replace every `artifact_local` occurrence with a durable marker. Parent-owned
surfaces include:

- current and historical inbox observations;
- MentalState;
- pending child terminal records;
- LLM/tool-result history;
- transition outcomes and terminal metadata;
- operator or trace projections that participate in snapshots.

The replacement must occur before snapshot sizing. Pruning after the limit is
detected is too late and must not truncate artifact content as a substitute for
proper offloading.

### Identity-preserving deduplication

One local artifact object referenced from several fields must be stored once and
all projected markers must use the same artifact ID. Deduplication must span the
complete candidate snapshot preparation operation, not use independent
`WeakMap`/`WeakSet` scopes for MentalState, inbox, LLM state, and outcome.

If independently cloned wrappers represent the same already-persisted artifact,
their existing marker ID must be preserved rather than storing the value again.

### Blocking-child delivery

`awaitCompletion: true` may expose an awaitable hydrated handle to agent code, but
must never expose a persistence representation whose enumerable JSON contains the
raw artifact value. The local fast path and the durable/restart path must project
equivalent child results.

### Deterministic failure handling

If a snapshot still exceeds the limit:

- one bounded prune/retry is acceptable only if it can change the candidate;
- an unchanged deterministic candidate must not be repeatedly re-admitted;
- the turn must produce one durable typed failure or needs-review outcome;
- duplicate Hatchet deliveries may nudge reconciliation but must not create new
  authoritative attempts for the same generation.

## Suspected Implementation Areas

This is a host-side diagnosis, not a confirmed framework root cause. Review:

- blocking child completion and local fast-path delivery;
- `prepareChildResultForPersistence()` calls made separately for MentalState,
  inbox, LLM state, and terminal outcome;
- artifact offload deduplication scope across the complete snapshot;
- conversion between `LocalArtifact`, `ArtifactImpl`, and plain markers before
  `SessionManager.saveSnapshot()` measures JSON bytes;
- retry classification after `LIMIT_WM_SNAPSHOT_TOO_LARGE`.

The current unit tests prove that one object graph deduplicates repeated
`LocalArtifact` references, and that large raw child strings are offloaded. They
do not cover one blocking child result projected independently into all parent
snapshot surfaces under the real SQL persistence path.

## Required Tests

### Artifact projection

- Blocking child returns one large `LocalArtifact`; parent snapshot contains one
  durable artifact identity and no raw value.
- The same artifact referenced from observation, MentalState, LLM history, and
  outcome is stored once.
- Multiple different artifacts remain distinct.
- Hydrated `ArtifactImpl` values remain compact through snapshot preparation.
- Restart and rehydration preserve the original artifact ID and content.

### Runtime parity

- SQL/in-process blocking and asynchronous child paths pass.
- Hatchet blocking and asynchronous child paths pass.
- A child completing inline before the parent transitions behaves identically to
  a later asynchronous completion.
- Duplicate terminal delivery does not duplicate artifact storage or parent
  execution.

### Limit and retry behavior

- A valid 600 KiB artifact does not approach the WM limit.
- A genuinely oversized non-artifact snapshot emits one limit event per bounded
  attempt and terminates deterministically.
- Prune retry does not repeat when the serialized candidate is unchanged.
- Hatchet does not queue repeated authoritative attempts for the failed
  generation.

### Compatibility

- Small inline child values remain inline.
- Existing artifact marker wire shape remains unchanged.
- Custom artifact backends continue to work.
- No database migration is required unless the final implementation introduces
  new durable metadata.

## Acceptance Criteria

1. A child-created artifact remains marker-sized on every parent persistence
   surface for both blocking and asynchronous child calls.
2. One logical local artifact produces one stored artifact and one durable ID.
3. The production-shaped 600 KiB reproduction completes below the normal 2 MiB
   WM cap in SQL/in-process and Hatchet.
4. No raw artifact value appears in the parent snapshot, LLM state, events, or
   terminal metadata.
5. One child completion causes at most one parent generation advance and one
   authoritative terminal result.
6. Existing child, artifact, snapshot, cancellation, timeout, and Hatchet suites
   remain green.

## Downstream Host Work

After the framework fix is available, `itupdated` will:

- migrate `fetch-page-router` to the canonical asynchronous child flow;
- keep one canonical artifact marker in router observations and MentalState;
- preserve both `content` and `html` only at the terminal compatibility boundary;
- add real SQL and Hatchet regression coverage using large artifact-backed HTML.
