# Spec: Plan Schema (Phase 1)

## Status

Implemented. `adr/0001-one-plan-truth.md` is **Accepted**. This
spec is the implementation contract for that ADR.

## Goal

Make **one Zod `Plan` / `PlanStep` schema** the only Plan truth in callAgent.

After this phase:

- `packages/core/src/types/plan.ts` matches the product language we want
  (`title`, `dependsOn`, `stale`, ISO timestamps) and the execution model we
  already have (structural `kind`, optional `intent`).
- Permanent docs describe **that** schema, not a second invented shape.
- Default Perception and default Learning refuse invalid plans as cognition.
- `internal/plan.proposed`, `plan.updated`, and `plan.step.updated` payloads
  are typed on `ObservationSchema`.
- Step `intent` cannot be a Policy-level planning intent.
- `PlanStep.result` and untyped `args` are gone.
- Agents can attach JSON `meta` without ATG fields in core.

This phase does **not** add a scheduler, `execute_step`, output refs,
validation state, lineage, TurnTrace extensions, or `MentalState.extensions`.

## Why this shape

The originating request
(`apps/docs/todo/done/improvements-planning-dependencies-etc.md`) needs
dependency-aware plans, typed extension metadata, and provenance. It assumed
the **documented** Plan (`dependsOn`, action-kinds, `args`) already existed.

It does not. Runtime `plan.ts` has `intent` and no `dependsOn`. Copying the
request’s Plan type would duplicate `Intent` as `kind` + `args` and weaken
APLRET. Copying `plan.ts` into the docs would freeze an incomplete 3.1 sketch.

Phase 1 takes the request’s **generic capability** (a real graph field, typed
`meta`, one schema) and implements it with framework rules:

| Request want | Phase 1 answer |
|---|---|
| `dependsOn` as a first-class field | Yes, on `PlanStep` |
| Typed plan/step metadata | Zod JSON `meta` + optional TS overlay; not ATG types |
| Source-compatible dual shape | No. One breaking schema, one migration note |
| `scheduling` mode | No (helpers in Phase 2, `execute_step` in Phase 4) |
| Output refs / validation / lineage | Later phases; `result` is removed now so it cannot keep growing |

## APLRET ownership (unchanged)

| Event | Owner |
|---|---|
| `PlanSchema` / parse | core (`types/plan.ts`); Perception at the inbox boundary |
| Authoritative write of `M.plans` | Learning only (`MemoryWriter.plans`) |
| Choose `create_plan` / `execute_next_step` / `repair_plan` | Policy |
| Produce a plan payload | Execution (effect) |
| Emit `internal/plan.*` | Transition |
| Ready/blocked selection | Phase 2 — `specs/plan-graph-helpers.md` |

### What the schema actually gates

`PlanSchema.parse` is the authority for **default Perception** and **default
Learning**. It does **not** make illegal plans unrepresentable in every path:

| Path | Gate |
|---|---|
| Default Perception, `plan.proposed` / `plan.updated` / `plan.step.updated` | Parse; on failure replace with `internal/validation.failed` (do not drop) |
| Default Learning `plans.set` / `add` / after `updateStep` | `PlanSchema.safeParse` the resulting plan; on failure do not write |
| Default `MemoryWriter.plans` merge | Trust-Learning, same as the rest of `M`. No extra parse in the writer. |
| Custom agent Learning | Can still write any `M.plans`. That is an agent bug, not a Phase 1 runtime lock. |
| Snapshot load | No silent migrator. Old `description`/`result` blobs stay opaque until the agent rewrites the plan. |

Do not claim “invalid graphs cannot enter `MentalState`.” Claim: they cannot
enter through the default plan observation path or the default Learning write
path.

## Normative schema

Home: `packages/core/src/types/plan.ts`.

Types MUST be inferred from Zod (`types-rules.md` Rule 2). No parallel
`interface` / handwritten `type` that repeats fields.

Objects MUST be `.strict()` so leftover `description`, `args`, `result`, and
action-kind strings fail loudly.

### Enums

```ts
export const PlanStatusSchema = z.enum([
  'proposed',
  'active',
  'stale',
  'completed',
  'failed',
  'cancelled',
]);

export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export const StepKindSchema = z.enum(['action', 'subgoal', 'internal']);
```

Do not use documented leftovers: `draft`, `todo`, `doing`, `done`,
`ask_user`, `call_tool`, `delegate_child`, `llm`.

`stale` is load-bearing for repair (Policy reads it and may emit
`repair_plan`). `proposed` matches `internal/plan.proposed`. `cancelled` is
kept from runtime.

### Executable step intent

Home: `packages/core/src/types/intent.ts` (Intent is already the closed union).

Split the current `IntentSchema` members into named object schemas, then:

```text
ExecutableStepIntentSchema
  = prompt_user | answer_with_llm | call_tool | delegate_to_child
    | complete | wait | internal

PlanningIntentSchema
  = create_plan | execute_next_step | repair_plan

IntentSchema
  = ExecutableStepIntentSchema ∪ PlanningIntentSchema
```

`PlanStep.intent` uses `ExecutableStepIntentSchema.optional()`.

A step MUST NOT store `create_plan`, `execute_next_step`, or `repair_plan`.
Phase 4 MUST add `execute_step` to `PlanningIntentSchema` and to `IntentSchema`,
and MUST NOT add it to `ExecutableStepIntentSchema`.

`wait` and `complete` on a step are allowed (they are effects, not “make a
plan”).

An `action` / `subgoal` / `internal` step with **no** `intent` is schema-valid.
That is a proposal or a placeholder. Execution MUST NOT invent an intent from
`kind`. Agents that run `execute_next_step` MUST have put an executable
`intent` on that step first (agent invariant, not a Zod require).

Do not invent a second `args` map. Tool arguments already live on
`{ kind: 'call_tool', toolName, args }`.

`packages/memory-engine/src/types/external/intent.ts` is a **historical
scaffold**, not the product Intent. `@a2arium/callagent-core` is the only
product `IntentSchema`. memory-engine must not depend on core (cycle: core
already depends on memory-engine), so do **not** re-export from core and do
**not** add `ExecutableStepIntent` / plan steps there.

Phase 1: put a file-top comment on that copy pointing at
`packages/core/src/types/intent.ts`. Do not change its member set in Phase 1
(it still matches today’s core).

Phase 4: add `execute_step` to **both** files in the same PR. Add
`packages/core/tests/intent.kind-parity.test.ts` that extracts
`kind: z.literal('…')` members from both files and asserts they are equal.
If the test fails, update the scaffold — do not grow a third Intent.

### JSON meta

Do not use `z.unknown()` for `meta` values. They MUST round-trip through
JSON snapshots.

Define a lazy JSON union in `plan.ts` (same idea as TurnTrace `JsonValue`,
**without** importing `turnTrace.ts`). Omit `undefined` as a value:

```ts
type PlanJsonValue =
  | string
  | number
  | boolean
  | null
  | PlanJsonValue[]
  | { [key: string]: PlanJsonValue };

export const PlanJsonValueSchema: z.ZodType<PlanJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PlanJsonValueSchema),
    z.record(z.string(), PlanJsonValueSchema),
  ])
);

export const PlanMetaSchema = z.record(z.string(), PlanJsonValueSchema);
```

Extracting a shared `jsonValue.ts` used by TurnTrace and Plan is allowed in
this PR if it stays a mechanical move. It is not required.

### PlanStep

```ts
export const PlanStepSchema = z.object({
  id: z.string().min(1),
  kind: StepKindSchema,
  goalId: z.string().min(1).optional(),
  title: z.string().min(1),
  status: StepStatusSchema.default('pending'),
  intent: ExecutableStepIntentSchema.optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  meta: PlanMetaSchema.optional(),
}).strict();
```

| Field | Rule |
|---|---|
| `id` | Unique within the plan (enforced on `Plan`, not here). |
| `kind` | Structural only. Never an action-kind. |
| `title` | Same idea as `GoalNode.title`. Replaces `description`. |
| `intent` | Optional executable intent. See agent invariant above. |
| `dependsOn` | Optional. Omitted and `[]` are equivalent. Duplicate ids in one list are **accepted** and treated as **one edge** (uniquify). Do not reject `dependsOn: ['A', 'A']`. Missing / self / cycle are still illegal. Readiness (Phase 2) uniquifies the same way. |
| `meta` | Optional JSON object. ATG / beliefs / scores belong here or in `worldModel`. Do not stash large payloads here because `result` is gone (Phase 3 adds output refs). |

Removed relative to runtime today: `description`, `result`.

Removed relative to docs today: action-kind enum, `args`.

### Plan

```ts
export const PlanSchema = z.object({
  id: PlanIdSchema, // z.string().min(1)
  goalId: z.string().min(1).optional(),
  steps: z.array(PlanStepSchema),
  cursor: z.number().int().nonnegative().default(0),
  status: PlanStatusSchema.default('proposed'),
  revision: z.number().int().nonnegative().default(0),
  meta: PlanMetaSchema.optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
```

Timestamps, when present, are ISO-8601 with offset **or** `Z`
(`z.string().datetime({ offset: true })`). This matches `GoalNode`’s ISO
strings better than UTC-only `datetime()`.

Missing timestamps are **legal forever**, not a temporary stub exception.
The default `create_plan` stub may omit them. Default Learning SHOULD stamp
`createdAt` / `updatedAt` with `new Date().toISOString()` (always `Z`) when
writing a plan that lacks them. That stamp is a Learning convenience, not a
schema require.

`cursor` remains **required** (default `0`). DAG agents do not delete it;
they ignore it for readiness (Phase 2/4). `cursor` MUST be in
`0..steps.length` inclusive (`cursor === steps.length` means sequential
exhaustion).

`revision` is a non-negative int. **Monotonicity across turns is not a Zod
check**; Learning must bump it on meaningful change (already in contracts).

No `scheduling` field.

### PlanState

Unchanged shape:

```ts
export const PlanStateSchema = z.object({
  plans: z.record(PlanIdSchema, PlanSchema),
  activePlanId: PlanIdSchema.optional(),
}).strict();
```

`activePlanId`, when set, MUST exist as a key in `plans` (`PlanStateSchema`
superRefine, not `PlanSchema`).

### SuperRefine error codes

Use `z.ZodIssueCode.custom` and set `params.errorCode` to these closed codes.
Implement the graph walk as a **file-local** function in `plan.ts`
(`collectPlanGraphIssues` or similar). Do **not** export it in Phase 1.
Phase 2 wraps the same function as public `validatePlanGraph` — do not copy
the cycle walk.

**`PlanSchema`**

| `params.errorCode` | Condition |
|---|---|
| `PLAN_DUPLICATE_STEP_ID` | Two steps share `id`. |
| `PLAN_DEPENDENCY_MISSING` | `dependsOn` names an id not in `steps`. |
| `PLAN_DEPENDENCY_SELF` | A step lists its own `id` in `dependsOn`. |
| `PLAN_DEPENDENCY_CYCLE` | Directed cycle in `dependsOn`. |
| `PLAN_CURSOR_OUT_OF_BOUNDS` | `cursor > steps.length` (Zod path `['cursor']`). |

**`PlanStateSchema`**

| `params.errorCode` | Condition |
|---|---|
| `PLAN_ACTIVE_ID_MISSING` | `activePlanId` is set and is not a key in `plans`. |

Do not throw unstructured `Error` strings.

### TypeScript overlay for `meta`

Default public types stay inferred:

```ts
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
```

Agents that need typed meta MAY use overlays. These are convenience, not a
second source of truth, and MUST stay assignable to `PlanStep` / `Plan`:

```ts
export type PlanStepWithMeta<
  StepMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
> = Omit<PlanStep, 'meta'> & { meta?: StepMeta };

export type PlanWithMeta<
  StepMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
  PlanMeta extends Record<string, PlanJsonValue> = Record<string, PlanJsonValue>,
> = Omit<Plan, 'meta' | 'steps'> & {
  meta?: PlanMeta;
  steps: PlanStepWithMeta<StepMeta>[];
};
```

Do not make `Plan` itself generic. That would break `z.infer` equality and
force every `MemoryWriter.plans` signature into generics (types-rules Rule 3).

### Plan step-updated payload

New schema in `plan.ts`:

```ts
export const PlanStepUpdatedPayloadSchema = z.object({
  planId: PlanIdSchema,
  stepId: z.string().min(1),
  patch: PlanStepSchema.partial().omit({ id: true }),
}).strict();
```

This replaces the default Learning destructure
`const { planId, stepId, ...patch } = payload` with a typed payload.
Transition/agent code that today spreads patch fields at the top level MUST
move them under `patch`.

After applying a patch, default Learning MUST `PlanSchema.safeParse` the
resulting plan. On failure, do not write the patch; leave `M.plans` unchanged.
Default Learning MUST also `PlanSchema.safeParse` on `plan.proposed` /
`plan.updated` before `writer.plans.set` / `add` (Perception already parsed;
this is defense in depth, not a second product behavior).

## Observation schema (MUST, not optional)

`ObservationSchema` MUST type plan payloads. 3.1 already required this; it
never landed. “Leave `payload: z.unknown()` if it is a compile blast” is
**not** allowed.

`ObservationSchema` is a `discriminatedUnion` on `source`. Two siblings with
`source: 'internal'` cannot be added at that level. Nest a `kind`
discriminated union on the internal branch:

```ts
z.object({
  source: z.literal('internal'),
  ...BaseObservationProps,
}).and(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('plan.proposed'), payload: PlanSchema }),
    z.object({ kind: z.literal('plan.updated'), payload: PlanSchema }),
    z.object({ kind: z.literal('plan.step.updated'), payload: PlanStepUpdatedPayloadSchema }),
    z.object({ kind: z.literal('llm.responded'), payload: LLMRespondedPayloadSchema.optional() }),
    z.object({ kind: z.literal('goal.updated'), payload: z.unknown() }),
    z.object({ kind: z.literal('validation.failed'), payload: ValidationFailedPayloadSchema }),
    z.object({ kind: z.literal('state.noted'), payload: z.unknown() }),
  ])
)
```

`plan.ts` MUST NOT import `observation.ts`. `observation.ts` MAY import plan
payload schemas.

`llm.responded` / `goal.updated` / `state.noted` payload tightening beyond
what already exists is **not** in scope except as needed to keep the nested
union compiling. Prefer existing `LLMRespondedPayloadSchema` and
`ValidationFailedPayloadSchema`. If `llm.responded` today is `z.unknown()`
and switching to `LLMRespondedPayloadSchema` breaks a wide test blast, keep
that one kind as `z.unknown()` and still type the three **plan** kinds. Plan
kinds are MUST.

Invalid **envelopes** already become `validation.failed` in
`normalizeObservationInbox`. Invalid **plan payloads** that still match the
envelope (wrong fields inside payload) may pass `ObservationSchema` if the
payload schema is attached — then they fail at Perception parse. If
`payload: PlanSchema` is on the observation, inbox normalize will already
turn a legacy `description` plan into `validation.failed` before Perception.
That is the desired loud path. Default Perception MUST still defend:

- if kind is plan.* and `PlanSchema` / `PlanStepUpdatedPayloadSchema` fails
  (e.g. custom Perception bypassed normalize), replace that observation with
  `internal/validation.failed`;
- do **not** drop the observation.

`ValidationFailedPayloadSchema` already exists:

```ts
{
  reason: string,           // use 'invalid_plan'
  schemaName?: string,      // 'PlanSchema' | 'PlanStepUpdatedPayloadSchema'
  zodError?: unknown,
  originalPayload?: unknown
}
```

Default Learning does not write `M.plans` from `validation.failed`. Policy
will not see a new plan. TurnTrace `inboxCurrent` MUST show `validation.failed`.
That is the loud signal. Do not keep the current “log warning and drop.”

## Parse sites (runtime)

| Site | Today | Phase 1 |
|---|---|---|
| `ObservationSchema` plan kinds | `payload: z.unknown()` | Typed payloads as above |
| Inbox normalize | envelope → `validation.failed` | Also catches plan payload failures once typed |
| Default Perception, plan.* | `PlanSchema.parse`, **drop** on failure | Parse; on failure **replace** with `validation.failed` |
| Default Perception, `plan.step.updated` | not parsed | Same as other plan kinds |
| Default Learning write | trusts Perception payload | `PlanSchema.safeParse` before set/add and after step patch |
| Default `MemoryWriter.plans` | merge | Unchanged (trust-Learning) |
| Default `create_plan` stub | `{ id, goalId, steps: [], status: 'proposed' }` | Keep; MUST still parse |
| Snapshot load | no parse | No silent migrator |

## Public exports

`PlanSchema` is documented as importable from `@a2arium/callagent-core`
(`apps/docs/migration/done/3.1-planning-model-migration.md`) but **is not
exported** from `packages/core/src/index.ts` today.

Phase 1 MUST export from the package root:

- schemas: `PlanIdSchema`, `PlanStatusSchema`, `StepStatusSchema`,
  `StepKindSchema`, `PlanStepSchema`, `PlanSchema`, `PlanStateSchema`,
  `PlanStepUpdatedPayloadSchema`, `PlanMetaSchema`, `PlanJsonValueSchema`,
  `ExecutableStepIntentSchema`, `PlanningIntentSchema`
- types: `PlanId`, `PlanStatus`, `StepStatus`, `StepKind`, `PlanStep`,
  `Plan`, `PlanState`, `PlanStepUpdatedPayload`, `PlanJsonValue`,
  `ExecutableStepIntent`
- overlays: `PlanStepWithMeta`, `PlanWithMeta`

`Intent` / `IntentSchema` remain exported as they are today.

## Default loop stub

`loopRunner` `create_plan` handler MUST keep producing a payload that parses:

```ts
{ id: `plan_${Date.now()}`, goalId, steps: [], status: 'proposed' }
```

Do not add fake steps. Do not put `description` back. Do not require
timestamps on this stub.

## Tests

### Schema unit

File: `packages/core/tests/planning.model.test.ts` (extend; do not create a
second schema-test file). Follow the existing Jest style in that file.
Import schemas from `../src/types/plan.js` and `../src/types/intent.js`.

Today’s three cases **will fail** after `description` → `title`. That is
expected. Update fixtures (`title` instead of `description`).

Accept:

- empty `steps`, default `cursor` 0, default `status` `proposed`
- omitted timestamps
- offset timestamp `2026-08-16T09:00:00.000+03:00` and `Z` timestamp
- `dependsOn: []` and omitted `dependsOn`
- `dependsOn: ['A', 'A']` when `A` exists (one edge, not `PLAN_DUPLICATE_STEP_ID`)
- `status: 'stale'`
- `meta: { graphKind: 'atomic-task-graph' }` on plan and step
- step `intent: { kind: 'call_tool', toolName: 'search' }`
- step with no `intent`
- `cursor === steps.length`

Reject:

- `description` instead of `title` (`.strict()` / missing `title`)
- `result` present
- `args` present
- `kind: 'call_tool'` on the step (not a `StepKind`)
- `kind: 'ask_user'` / `'todo'` / `'done'` / `'draft'`
- step `intent: { kind: 'create_plan', goalId: 'g1' }`
- step `intent: { kind: 'execute_next_step', planId: 'p1' }`
- step `intent: { kind: 'repair_plan', planId: 'p1', reason: 'x' }`
- duplicate step ids
- `dependsOn: ['missing']`
- self-dependency
- cycle `A→B→C→A`
- numeric `createdAt`
- `meta: { ts: new Date() }` (non-JSON)
- `scheduling` field
- `activePlanId` that is not a key in `plans`

### Type tests (required)

`packages/core` already has `yarn test:types` (`tsd`, `tests/*.test-d.ts`).
Add `packages/core/tests/plan.types.test-d.ts` using `expectType` from `tsd`,
same style as `llmContracts.types.test-d.ts`.

MUST assert:

- `PlanStep['intent']` is `ExecutableStepIntent | undefined`
- a value `{ kind: 'create_plan', goalId: 'g' }` is **not** assignable to
  `PlanStep['intent']`
- `Plan['status']` includes `'stale'`
- `PlanStep['kind']` does not include `'call_tool'`
- `PlanWithMeta<{ graphKind: string }>` is assignable to a context that
  reads `meta` as optional

Do not add a second type-test runner.

### Loop regression

Add a focused test (`planning.model.test.ts` if fast, else
`packages/core/tests/planning.loop-stub.test.ts`):

1. Default modules, Policy emits `create_plan`, one harness/`runTurn`.
2. Assert Transition emits `internal/plan.proposed` whose payload
   `PlanSchema.safeParse` succeeds.
3. Inject a **legacy** payload
   `{ id, steps: [{ id, kind: 'internal', description: 'x' }] }` as
   `plan.proposed`.
4. Assert the turn’s inbox / TurnTrace contains `internal/validation.failed`
   (`schemaName` `PlanSchema` when present).
5. Assert `M.plans` was **not** written from that payload.

Do not weaken other suites by changing them to `any`. If a suite fails
because it constructed a Plan with `description`, **fix the fixture** to
`title`; do not restore `description` on the schema.

### Known failing tests from this change (review)

Repo search at spec time: the **only** production/test constructors of
`PlanSchema` objects are:

- `packages/core/tests/planning.model.test.ts`
- default `create_plan` stub in `loopRunner.ts` (empty steps — still valid)

Typing internal observation payloads **will** narrow `Observation` and may
fail call sites that stuffed untyped plan payloads. Fix those call sites to
the new payload types. That is expected, not a reason to keep
`payload: z.unknown()`.

| Failure | Action |
|---|---|
| Fixture uses `description` / `result` / action-kind | Update fixture to this schema |
| Snapshot JSON of old plans re-parsed | Do not auto-migrate; stop parsing or update the snapshot |
| Observation type narrowing after payload split | Fix call sites; do not untype plan kinds |
| `llm.responded` payload blast if tightened | Keep that kind `z.unknown()`; still type plan kinds |
| `memory-engine` Intent scaffold | Comment only in Phase 1; kind-parity test lands in Phase 4 with `execute_step` |
| Unrelated red tests that already existed | Do not “fix” by loosening Plan schema |

Run `yarn test` in `packages/core` **and** `yarn test:types` before merge.

## Docs to update in the **same change set** as `plan.ts`

Permanent docs must not keep a second Plan type. Rewrite examples from the
schema; do not leave “recommended shape” that disagrees with `plan.ts`.

| Doc | What to change |
|---|---|
| `apps/docs/0-aplret_contracts.md` | Replace the Plan/PlanStep/PlanStatus/StepKind/StepStatus block under Public types with the inferred shape (or “see `PlanSchema`”). Fix plan-integration bullets that say step status `done`. Add `dependsOn` + structural `kind` + `intent` to Planning model. Extend the plan-invariants row: unique step ids; `dependsOn` targets exist; no self-edge; no cycle. Keep cursor bounds + revision monotonicity. Invalid plan observations become `internal/validation.failed`, not a silent drop. |
| `apps/docs/8-spec_goals_and_plans_in_aplret.md` | Replace the Plan data model. Policy examples: `prompt_user` not `ask_user`; step execution via `step.intent` / `execute_next_step`, not `kind: 'call_tool'` on the step. Keep `stale` → `repair_plan`. Note `dependsOn` is stored now; readiness helpers are Phase 2 (`specs/plan-graph-helpers.md`). Optional `intent` on proposed steps. Until Phase 2 docs land, do not delete the cursor sequential path. |
| `apps/docs/9-how_to_implement_planning_without_breaking_policy_purity.md` | Replace the “strict plan schema” snippet. Learning `validatePlan` = `PlanSchema.parse`. Execution interprets `step.intent`, not `step.kind === 'call_tool'`. Do not invent intent from kind. |
| `apps/docs/3-how_to_keep_policy_pure.md` | Case 5 already uses `create_plan` / `execute_next_step`. Only fix if it still shows `ask_user` as a **step kind**. |
| `apps/docs/12-how_to_debug_with_turn_trace.md` | If it mentions dropped plan observations, point at `validation.failed` in `inboxCurrent`. Only touch if that sentence exists. |
| `apps/docs/migration/plan-schema-one-truth.md` | **New** end-user migration (not under `done/` until shipped). See below. |

Do **not** rewrite in this phase:

- `apps/docs/migration/done/3.1-planning-model-migration.md` (historical).
- `apps/docs/todo/done/next-phase-better-readability/3.1-planning-model.md` (historical spec).
- Goal types in contracts (`Goal` vs runtime `GoalNode`) — separate drift.
- Drafts under `apps/docs/drafts/` unless a snippet is copy-pasted into a
  permanent how-to in the same PR.
- `apps/docs/todo/done/improvements-planning-dependencies-etc.md` — originating
  request; point at this harness instead of editing it into a third schema.

### New migration note (required)

Create `apps/docs/migration/plan-schema-one-truth.md`:

- Not backward compatible.
- Field map: `description` → `title`; drop `result` and `args`; step `kind`
  is only `action \| subgoal \| internal`; put the action in `intent`.
- Status map: `todo`/`doing`/`done` → `pending`/`running`/`completed`;
  `draft` → `proposed`.
- `dependsOn` now exists and is validated on parse.
- Import `PlanSchema` from `@a2arium/callagent-core`.
- Old snapshots: plans in `M.plans` are not auto-migrated; repair/re-propose
  the plan or clear the snapshot.
- Do **not** put large step results in `meta` because `result` was removed.
  Compact output refs are Phase 3. Until then, store artifact handles in
  `worldModel` / scratch the way other compact facts are stored, or wait
  for Phase 3.

## Out of scope (do not sneak in)

- `execute_step` intent
- Exported `validatePlanGraph` / `selectReadyPlanSteps` (Phase 2 —
  `specs/plan-graph-helpers.md`)
- `outputs` / `validation` / `lineage`
- `TurnTrace.extensions`
- `MentalState.extensions` / generic `MentalState` beyond `Sensory`
- Making `cursor` optional
- Parallel Policy intents
- ATG / belief / EFE types
- Changing default Policy (there isn’t a real planner Policy in core)
- Parsing plans on snapshot load / auto-migration
- Parsing inside `MemoryWriter` (trust-Learning)

## Acceptance

- `PlanSchema.parse` accepts the fixtures in Tests / Accept and rejects
  Tests / Reject.
- `ObservationSchema` types the three plan kinds.
- Invalid plan observations surface as `internal/validation.failed`; they
  are not dropped.
- `0-aplret_contracts.md`, `8-spec_goals_and_plans_in_aplret.md`, and
  `9-how_to_implement_planning_without_breaking_policy_purity.md` show the
  same field names and enums as `plan.ts`.
- `@a2arium/callagent-core` exports the schemas.
- Default `create_plan` stub still parses.
- `yarn test` and `yarn test:types` in `packages/core` are green.
- No `description` / `result` / action-kind on `PlanStep` in core types.

## Implementation order

1. Split intent object schemas; add `ExecutableStepIntentSchema`.
2. Rewrite `plan.ts` (JSON meta, datetime offset, file-local graph issues).
3. Type plan kinds on `ObservationSchema` (nested `kind` union).
4. Perception: replace invalid plan.* with `validation.failed`; parse
   `plan.step.updated`; default Learning re-parse before write.
5. Export from `index.ts`.
6. Rewrite `planning.model.test.ts`, add `plan.types.test-d.ts`, add loop
   stub / `validation.failed` test.
7. Rewrite the three permanent docs + new migration note.
8. `yarn test` + `yarn test:types` in `packages/core`; fix remaining Plan
   or Observation fixtures without loosening the schema.
