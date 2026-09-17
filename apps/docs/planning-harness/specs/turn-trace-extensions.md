# Spec: TurnTrace Extensions (Phase 5a)

## Status

Implemented. `adr/0006-turntrace-extensions-are-telemetry.md` is **Accepted**.
Does not depend on plan schema Phases 1–4, but planning agents are the
first intended users.

## Goal

Let agents attach **compact, namespaced, versioned** telemetry to the
turn’s `TurnTrace` without adding domain fields to core and without
storing blobs in the trace.

Originating request §§9–10 and §15 (`DecisionTrace`). Sidecar bulk stays
in artifacts; the trace only correlates.

## Why this shape

| Request want | Phase 5a answer |
|---|---|
| `extensions?: { namespace, version, data }[]` | Yes |
| First-class `related?: TraceRef[]` | **No.** Put `{ artifactId }` (or similar) inside `data` |
| `TurnTrace.memoryReads` | **No** first-class field. Operator `memory.read` already exists; optional extension in the sibling spec |
| Core `DecisionTrace` type | **No.** Example namespace only |
| ATG / belief fields on TurnTrace | **No** |

## APLRET ownership

| Concern | Owner |
|---|---|
| `TurnTraceSchema` | core (`types/turnTrace.ts`) |
| Authoritative cognition | Learning → `M` |
| Compact planner/RAG/decision telemetry | Optional extensions (any module except as **cognition**). Policy MUST NOT read traces to decide |
| Large dumps | Artifacts; id in `data` |

Extensions are **not** a writer of `M` and **not** an inbox observation.

## Normative schema

Home: `packages/core/src/types/turnTrace.ts`.

Prefer **Plan-style JSON** (no `undefined`) for `data`, even though
today’s `JsonValue` in this file allows `undefined`. Either:

- reuse a shared `jsonValue.ts` without `undefined` (allowed; mechanical),
  or
- define `TurnTraceExtensionDataSchema` as the Phase 1 `PlanJsonValue`
  union (no `undefined`).

```ts
export const TurnTraceExtensionSchema = z.object({
  namespace: z.string().min(1),
  version: z.string().min(1),
  data: TurnTraceExtensionDataSchema,
}).strict();
```

Add to `TurnTraceSchema`:

```ts
extensions: z.array(TurnTraceExtensionSchema).optional(),
```

Omitted and `[]` are equivalent for readers.

`namespace` SHOULD be dotted (`planning.graph`, `retrieval.rag`,
`agent.mybot.decision`). Do not Zod-regex it in v1 (too cute; breaks
underscores). Document reserved prefixes `aplret.` and `callagent.` for
framework-owned extensions. Agents MUST NOT use those prefixes.

`version` is a string (`"1"`, `"1.1"`), not a number — JSON and docs stay
aligned with the request.

`.strict()` rejects `payload` / `related` sibling keys on the item.

Do not add `related` on `TurnTrace`.

## Recorder API

`TurnTraceCollector` today only stores finished traces. Add a **per-turn
buffer** the loop copies into `TurnTrace.extensions` when it builds the
trace.

Learning has **no** `ctx`. Do **not** pass `ctx` into Learning so it can
record extensions. `recordTurnTraceExtension` is an **Execution** API
(Execution already has `ctx`), or a factory that closes over `ctx` from
Execution / loop setup. Policy is `(m, mem)` and also has no `ctx`.

```ts
export function recordTurnTraceExtension(
  ctx: TaskContext,
  extension: TurnTraceExtension
): void
```

- No-op when traces are not collected.
- `TurnTraceExtensionSchema.safeParse` first; on failure **do not throw**;
  skip the item (telemetry must not fail the turn).
- Append order = call order.
- Duplicate `namespace`+`version` MAY both appear (two notes same turn).
  Do not last-write-wins unless we document it — **keep both** (simpler,
  lossless).
- Export from `@a2arium/callagent-core` for agent **Execution**.
- Do not pass `ctx` into Learning or Policy to record extensions.

LoopRunner copies the buffer onto the trace object before
`collector.push`. Clear the buffer after the turn so the next turn
starts empty.

## Tests

New `packages/core/tests/turnTrace.extensions.test.ts` plus tsd in
existing turn-trace type tests if present, else `plan.types.test-d.ts`
is the wrong file — add `turnTrace.types.test-d.ts` only if no turn-trace
tsd exists. Prefer extending an existing `*.test-d.ts` that already
imports `TurnTrace`.

Schema:

- accept omitted `extensions`;
- accept one planning.graph example (planId, revision, readySteps ids);
- accept `data` with nested objects/arrays;
- reject `data: { ts: new Date() }` (non-JSON);
- reject missing `namespace`;
- reject extra keys on the item;
- `JSON.stringify` round-trip.

Loop / harness:

- `recordTurnTraceExtension` during **Execution**; `lastTrace().extensions`
  contains it (do **not** record from Learning — Learning has no `ctx`);
- invalid extension does not throw and is absent from the trace;
- next `runTurn` does not leak the previous turn’s extensions;
- Policy-only turn with no recorder → `extensions` omitted or `[]`.

Do **not** assert ATG fields.

### Known regression review

| Failure | Action |
|---|---|
| `TurnTraceSchema.parse` in tests missing new optional field | Optional — should not fail |
| Golden traces / snapshots of full TurnTrace | Update fixtures to allow `extensions` or omit; do not require it |
| `JsonValue` `undefined` vs Plan JSON | Extension `data` must not use `undefined`; do not loosen Plan meta |
| Trace size budgets | Keep examples tiny; if a test stuffed a blob into `data`, move it to an artifact id |

Run `yarn test` and `yarn test:types` in `packages/core`.

## Docs to update in the **same change set**

| Doc | What to change |
|---|---|
| `apps/docs/0-aplret_contracts.md` | TurnTrace shape: optional `extensions`. Explicit: not cognition. |
| `apps/docs/12-how_to_debug_with_turn_trace.md` | How to attach a namespace; sidecar artifact id in `data`; do not dump RAG chunks. |
| `apps/docs/11-how_to_test_aplret_agents.md` | Assert extensions in `expectTurn` when the agent records them. |
| `apps/docs/8-spec_goals_and_plans_in_aplret.md` | One line: planner candidates belong in an extension, not `M`. |

Do **not** add ATG examples as if they were framework types. A
`planning.graph` compact example (ids only) is enough.

## Out of scope

- First-class `related` / `memoryReads` / `DecisionTrace`
- `MentalState.extensions`
- Auto-recording planner extensions in default loop
- Operator UI layout
- Durable storage of traces beyond what already exists

## Acceptance

- Schema accept/reject cases pass.
- Recorder is opt-in; invalid items do not fail the turn.
- No new first-class ATG/planner keys on `TurnTrace`.
- Docs agree.
- `yarn test` and `yarn test:types` in `packages/core` are green.

## Implementation order

1. `TurnTraceExtensionSchema` + optional field on `TurnTraceSchema`.
2. Per-turn buffer + `recordTurnTraceExtension` + loop copy/clear.
3. Tests + exports.
4. Docs.
5. Full core `yarn test` + `yarn test:types`.
