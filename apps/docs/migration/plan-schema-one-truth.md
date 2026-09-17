# Migration: one Plan schema (`title`, `dependsOn`, structural `kind`)

This change is **not backward compatible**. `PlanSchema` in
`@a2arium/callagent-core` is the only Plan truth.

Import:

```ts
import { PlanSchema, type Plan, type PlanStep } from '@a2arium/callagent-core';
```

## Field map

| Old | New |
|---|---|
| `description` | `title` |
| `result` | **removed** in Phase 1. Replacement is optional `outputs?: PlanOutputRef[]` (`artifact \| memory \| evidence` only — no `value` kind). Do not put blobs in `meta`. |
| `args` | **removed** (tool args live on `{ kind: 'call_tool', toolName, args }`) |
| step `kind: 'call_tool' \| 'ask_user' \| …` | structural `kind: 'action' \| 'subgoal' \| 'internal'` plus optional `intent` |
| `status: 'todo' \| 'doing' \| 'done'` | `'pending' \| 'running' \| 'completed'` |
| plan `status: 'draft'` | `'proposed'` |
| numeric `createdAt` / `updatedAt` | optional ISO-8601 with offset or `Z` |

`dependsOn` now exists and is validated on parse: unique step ids; targets
exist; no self-edge; no cycle. Duplicate ids in one `dependsOn` list are
accepted as **one edge**.

Graph helpers (`validatePlanGraph`, `selectReadyPlanSteps`, …) ignore
`cursor` and `plan.status`. There is no `scheduling` field on `Plan`.
Sequential agents keep `execute_next_step` + `cursor`.

A step MUST NOT store `create_plan`, `execute_next_step`, `execute_step`, or `repair_plan`.
Those are Policy-level intents.

`execute_step { planId, stepId }` is a Planning intent. Default Execution
dispatches that stored step (shared with `execute_next_step`, which uses
`plan.steps[plan.cursor]`). `execute_next_step` is no longer a no-op:
it runs the cursor step and may advance `cursor` after completion
(`advanceCursor`). `execute_step` never advances `cursor`.

`internal/plan.patch` is a new observation kind (`{ planId, patch }`). Do not send a
patch as `plan.updated`. Exhaustive `kind` switches must include `plan.patch` and
`execute_step`.

`TestHarness.snapshot()` / `fork()` isolate test branches. Production `Snapshot`
(session resume) is unchanged.

## Snapshots

Plans already stored in `M.plans` are **not** auto-migrated. Repair or
re-propose the plan, or clear the snapshot. Old `description` / `result`
blobs stay opaque until the agent rewrites the plan.

Optional `outputs`, `validation`, and `lineage` may be omitted. Old
snapshots without those fields still parse. Do **not** put large step
results in `meta` because `result` was removed.
