# Spec: PlanPatch and Graph Diff (Phase 6a)

## Status

Ready for implementation after Phases 1–2 (schema + graph walk).
Phase 3 lineage SHOULD exist so apply can set `parentRevision`; if Phase
3b has not landed, omit lineage in default Learning and still bump
`revision`.
`adr/0008-planpatch-is-learning-owned.md` is **Accepted**.

Phase 4 (`execute_step`) is not required.

## Goal

Give Learning a **structured, validated** way to repair a plan without
replacing the whole object by guesswork, and give tests/UI a
`diffPlanGraph` over two parsed plans.

Originating request §§16–17. Ownership stays APLRET: Policy emits
`repair_plan`; Execution may generate a candidate patch; Learning
applies.

## Why this shape

| Request want | Phase 6a answer |
|---|---|
| `PlanPatch` ops add/remove/update step, add/remove dep | Yes, closed union |
| `validatePlanPatch` / `applyPlanPatch` / `diffPlanGraph` | Yes, pure, result types |
| Policy applies the patch | **No** |
| New Policy intent | **No.** Keep `repair_plan` |
| Auto-mutate descendants | **No.** Learning may follow `getPlanDescendants` |

## APLRET ownership

```text
Policy → repair_plan
  → Execution generates candidate PlanPatch (effect)
  → Transition emits internal/plan.patch
  → Perception parses PlanPatch
  → Learning applyPlanPatch + PlanSchema.safeParse + writer.plans
```

Helpers never write `M`. Execution never writes `M.plans`.

## Normative schema

Home: `packages/core/src/plans/planPatch.ts` (behavior + Zod). Types
inferred. `.strict()`.

```ts
export const PlanPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_step'), step: PlanStepSchema }).strict(),
  z.object({ op: z.literal('remove_step'), stepId: z.string().min(1) }).strict(),
  z.object({
    op: z.literal('update_step'),
    stepId: z.string().min(1),
    patch: PlanStepSchema.partial().omit({ id: true }),
  }).strict(),
  z.object({
    op: z.literal('add_dependency'),
    stepId: z.string().min(1),
    dependsOn: z.string().min(1),
  }).strict(),
  z.object({
    op: z.literal('remove_dependency'),
    stepId: z.string().min(1),
    dependsOn: z.string().min(1),
  }).strict(),
  z.object({
    op: z.literal('set_cursor'),
    cursor: z.number().int().nonnegative(),
  }).strict(),
]);

export const PlanPatchSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(PlanPatchOpSchema).min(1),
}).strict();
```

`update_step.patch` MUST NOT include `id` (omit). Changing a step’s id
is `remove_step` + `add_step`.

`set_cursor` is allowed so sequential repair can reset the index in the
**same** apply as `remove_step`. Do not add `move_step` or ATG ops.

### Observation

Nested internal `kind` union (Phase 1) gains:

```ts
z.object({
  kind: z.literal('plan.patch'),
  payload: z.object({
    planId: PlanIdSchema,
    patch: PlanPatchSchema,
  }).strict(),
})
```

Default Perception: parse; on failure replace with
`internal/validation.failed` (do not drop).

Default Learning: `validatePlanPatch` + `applyPlanPatch` +
`PlanSchema.safeParse`; on failure do not write. On success
`writer.plans.update` / `set`, bump `revision` by 1, set
`lineage.parentRevision` when Phase 3b exists.

`plan.updated` remains a **full Plan** payload (Phase 1). Do not send a
patch as `plan.updated`.

## Pure functions

```ts
export type PlanPatchResult =
  | { ok: true; plan: Plan }
  | { ok: false; errors: PlanGraphIssue[] };

export function validatePlanPatch(plan: Plan, patch: unknown): PlanPatchResult
export function applyPlanPatch(plan: Plan, patch: PlanPatch): PlanPatchResult
```

`validatePlanPatch` parses `patch` then dry-runs apply (or shares apply
and discards). Never throws.

Apply semantics (in `operations` order):

| op | Success | Fail codes |
|---|---|---|
| `add_step` | append to `steps` | `PLAN_DUPLICATE_STEP_ID` if id exists |
| `remove_step` | remove step; strip that id from others’ `dependsOn` | `PLAN_STEP_NOT_FOUND` |
| `update_step` | merge patch onto step | `PLAN_STEP_NOT_FOUND` |
| `add_dependency` | append to that step’s `dependsOn` (uniqued) | `PLAN_STEP_NOT_FOUND`, `PLAN_DEPENDENCY_MISSING` if target id absent, `PLAN_DEPENDENCY_SELF` |
| `remove_dependency` | remove that edge; ok if already absent | `PLAN_STEP_NOT_FOUND` |
| `set_cursor` | set `plan.cursor` | (checked after all ops; see clamp) |

Then: if `patch.baseRevision !== plan.revision` →
`PLAN_PATCH_REVISION_MISMATCH` (**before** ops).

After all ops:

1. If any op was `set_cursor` and `cursor > steps.length` →
   `PLAN_CURSOR_OUT_OF_BOUNDS` (explicit illegal index).
2. Else if `cursor > steps.length` → **clamp** `cursor` to
   `steps.length` (sequential exhaustion). Do **not** fail the apply.
3. Run the same graph walk as `PlanSchema` (shared
   `collectPlanGraphIssues`) on the result. Cycles / missing deps / etc.
   fail the apply. Cursor is already in bounds, so the walk must not
   reject a clamped sequential repair.

Do not copy the walk.

Returned `plan` has the **same** `revision` as input. Learning bumps it
on write. Helpers must not bump (so dry-run validate matches apply).

`applyPlanPatch` input `plan` is already a `Plan`. Do not re-parse the
plan as `unknown` (Learning just read it from `M`). Still run graph
issues after ops.

### `diffPlanGraph`

```ts
export const PlanGraphDiffSchema = z.object({
  addedSteps: z.array(z.string().min(1)),
  removedSteps: z.array(z.string().min(1)),
  changedSteps: z.array(z.string().min(1)),
  addedDependencies: z.array(z.object({
    stepId: z.string().min(1),
    dependsOn: z.string().min(1),
  }).strict()),
  removedDependencies: z.array(z.object({
    stepId: z.string().min(1),
    dependsOn: z.string().min(1),
  }).strict()),
}).strict();

export function diffPlanGraph(before: Plan, after: Plan): PlanGraphDiff
```

- Step ids in **`before.steps` then newly added in `after.steps` order**
  for added; removed in `before` order; changed in `after` order.
- `changedSteps`: same id, `PlanStep` JSON not equal (including
  status / title / intent / outputs / validation / dependsOn).
- Dependencies: edge sets. Unique. Stable sort by `stepId` then
  `dependsOn`.
- Ignores `cursor`, `revision`, `lineage`, `status` of the **plan**,
  `meta` of the plan? **Include plan-level? No** — this is a **step
  graph** diff. Plan `status` / `cursor` / `meta` / `lineage` are not in
  the diff object. Tests that need those compare `Plan` fields
  separately.
- Never throws. Two parsed plans in.

Do not make diff a writer. Do not emit observations from diff.

## Error codes

Reuse Phase 1/2 `PlanGraphErrorCode` plus:

```text
PLAN_PATCH_REVISION_MISMATCH
PLAN_PATCH_INVALID
```

`PLAN_PATCH_INVALID` = Zod failure on the patch object (empty
`operations`, bad `op`, leftover fields). Map like
`PLAN_SCHEMA_INVALID`.

Extend `PlanGraphErrorCodeSchema` in Phase 2’s enum **or** a
`PlanPatchErrorCodeSchema` that unions them. Prefer **one** enum so
Learning handles one closed set. Phase 2 spec listed a closed enum —
this phase **adds members**. That is a breaking add to the enum
(allowed: new codes). Update Phase 2 tests that exhaust the enum.

## Tests

New `packages/core/tests/planPatch.test.ts`. Fixtures through
`PlanSchema.parse`.

- add_step then graph still parses;
- remove_step strips downstream `dependsOn`;
- remove_step that leaves `cursor` past `steps.length` **succeeds** and
  clamps `cursor` to `steps.length` (no `set_cursor` in the patch);
- `set_cursor: 0` after deleting a prefix → cursor 0;
- `set_cursor` past `steps.length` → `PLAN_CURSOR_OUT_OF_BOUNDS`;
- update_step cannot change `id`;
- add_dependency cycle → apply `ok: false`, `PLAN_DEPENDENCY_CYCLE`;
- wrong `baseRevision` → `PLAN_PATCH_REVISION_MISMATCH`;
- `validatePlanPatch` never throws;
- default Learning: `plan.patch` observation applies and bumps
  revision; bad patch → `validation.failed`; `M` unchanged;
- `diffPlanGraph` on add+edge matches addedSteps / addedDependencies;
- Policy cannot apply: no test that Policy calls writer (existing
  purity harness).

Type tests: `PlanPatch['operations'][number]['op']` closed; `applyPlanPatch`
result is `ok` discriminant.

### Known regression review

| Failure | Action |
|---|---|
| Phase 1 `plan.updated` payload is still `Plan` | Keep it; patch is `plan.patch` |
| Phase 2 error-code exhaustiveness | Add the new codes; do not switch to `string` |
| Observation nested kind union compile blast | Add the new kind next to plan.* (Phase 1 pattern) |
| Default `create_plan` stub | Unrelated; still empty steps |
| Auto descendant skip | Do not add |

Run `yarn test` and `yarn test:types` in `packages/core`.

## Docs to update in the **same change set**

| Doc | What to change |
|---|---|
| `apps/docs/0-aplret_contracts.md` | `plan.patch` observation; Learning-only apply; error codes. |
| `apps/docs/8-spec_goals_and_plans_in_aplret.md` | Repair: `repair_plan` → patch observation → Learning. |
| `apps/docs/9-how_to_implement_planning_without_breaking_policy_purity.md` | LLM produces `PlanPatch` in Execution, not in Policy. |
| `apps/docs/11-how_to_test_aplret_agents.md` | Unit-test patches with `PlanSchema.parse` fixtures; turn-script for Learning apply. |
| `apps/docs/12-how_to_debug_with_turn_trace.md` | `inboxCurrent` shows `plan.patch` or `validation.failed`. |
| `apps/docs/migration/plan-schema-one-truth.md` | New observation kind; exhaustive `kind` switches. |

## Out of scope

- Policy/Execution writing `M.plans`
- ATG-specific ops
- Auto-invalidating descendants
- Operator graph UI
- Harness `fork` (sibling spec)

## Acceptance

- Apply/validate/diff cases pass; never throw unstructured errors.
- Sequential `remove_step` that would OOB `cursor` succeeds via clamp.
- Explicit illegal `set_cursor` still fails.
- Default Learning apply path is the only writer.
- Invalid patch is `validation.failed`, not a drop.
- Docs agree.
- `yarn test` and `yarn test:types` in `packages/core` are green.

## Implementation order

1. `PlanPatchSchema` + observation kind.
2. `applyPlanPatch` / `validatePlanPatch` sharing the graph walk.
3. `diffPlanGraph`.
4. Default Perception + Learning.
5. Tests + docs + enum exhaustiveness.
6. Full core `yarn test` + `yarn test:types`.
