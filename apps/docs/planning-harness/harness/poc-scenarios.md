# Planning Model POC Scenarios

These scenarios validate the planning model before production schema changes
are treated as done. They are intentionally small and deterministic. Expand
each with exact fixtures when the matching spec is written.

Gates refer to the testing principles in `../testing-principles.md`.

Scenario 0 is Phase 1. Scenarios 1–2 are Phase 2
(`specs/plan-graph-helpers.md`). Scenario 3 is sequential Policy (unchanged
by Phase 2). Scenarios 4–5 are Phase 3. Scenario 6 is Phase 4. Scenario 7
is Phase 5. Scenario 8 is Phase 6.

## Scenario 0 — schema truth

Purpose: prove docs and `PlanSchema` are the same type.

Normative cases: `specs/plan-schema.md` § Tests.

```text
parse a sequential plan with title, cursor, optional intent, no dependsOn
parse empty steps (default create_plan stub)
parse stale status and opaque meta
reject cursor out of bounds
reject create_plan / execute_next_step / repair_plan as a step intent
reject kind: 'call_tool' on the step
reject description / result / args leftover fields
reject missing dependency, self-dependency, cycle, duplicate step id
default create_plan observation still parses
legacy description payload becomes internal/validation.failed; M.plans not written
```

Expected: Phase 1 schema tests green; contracts / spec / how-to examples
parse with `PlanSchema`; `packages/core` suite green.

## Scenario 1 — missing / self / cycle

Purpose: graph validation is loud and structured. Same walk as `PlanSchema`.

Normative cases: `specs/plan-graph-helpers.md` § `validatePlanGraph`.

```text
dependsOn references a missing id → PLAN_DEPENDENCY_MISSING
step depends on itself → PLAN_DEPENDENCY_SELF
A→B→C→A → PLAN_DEPENDENCY_CYCLE
duplicate step ids → PLAN_DUPLICATE_STEP_ID
leftover description / missing title → PLAN_SCHEMA_INVALID
cursor out of bounds → PLAN_CURSOR_OUT_OF_BOUNDS
validatePlanGraph never throws
codes match PlanSchema.safeParse params.errorCode
```

Expected: public `validatePlanGraph`; one cycle walk shared with Phase 1.

## Scenario 2 — two ready steps

Purpose: DAG readiness without a loop scheduler. Helpers ignore `cursor`.

Normative cases: `specs/plan-graph-helpers.md` § Ready / blocked and Lookups.

```text
A and B pending, no deps; C pending dependsOn [A, B]
ready = [A, B] in steps order; blocked = [C]
complete A → ready = [B], blocked = [C]
complete A and B → ready = [C], blocked = []
A failed or skipped → C stays blocked
C running → C is neither ready nor blocked
cancelled / stale plan with a pending independent step → still ready
cursor-only three pending steps, no dependsOn, cursor 0 → all three ready
  (sequential Policy still uses cursor; this is not a bug)
missing stepId lookup → PLAN_STEP_NOT_FOUND, not []
diamond ancestors unique; self not included
```

Expected: helpers only; Policy still emits one intent. No `scheduling` field.
No `requireValidatedDependencies` (Scenario 4 / Phase 3).

## Scenario 3 — sequential cursor still works

Purpose: existing how-to path does not require `dependsOn`.

```text
create_plan → Learning writes plan
execute_next_step uses cursor
tool completion observation → Learning marks step completed, advances cursor
```

Expected: TurnTrace shows plan observation, Learning hash change, then next
intent.

## Scenario 4 — completed but not validated

Purpose: optional validation gate (Phase 3b). Default helper unchanged.

Normative cases: `specs/plan-validation-and-lineage.md`.

```text
A completed, no validation; C depends on A
no options → C ready (Phase 2)
requireValidatedDependencies true → C blocked
A.validation.status valid + flag → C ready
A.validation.status invalid|pending|unknown + flag → C blocked
parentRevision >= revision → PLAN_LINEAGE_PARENT
JSON round-trip keeps validation and lineage
```

Expected: no `selectRunnablePlanSteps`; no `MentalState.extensions`.

## Scenario 5 — output refs, not payloads

Purpose: artifact rule on steps (Phase 3a).

Normative cases: `specs/plan-output-refs.md`.

```text
step completion writes outputs: [{ kind: 'artifact', ref }]
kinds artifact | memory | evidence accepted
kind value / payload / result rejected
duplicate output name on one step rejected
refs survive JSON snapshot/resume
```

Expected: Phase 1 leftover-`result` rejects still fail.

## Scenario 6 — execute_step (Phase 4)

Normative cases: `specs/execute-step-intent.md`.

```text
A and B ready
Policy emits execute_step(planId, A)
Execution dispatches A's stored intent, not B
pending.tools[token] has planId/stepId/advanceCursor false
tool.completed → default Learning marks A completed; B still pending
cursor unchanged
blocked pending C named by Policy still dispatches (Execution does not check dependsOn)
execute_next_step uses the same dispatcher and advances cursor after completion
missing step / no intent → structured exec error; M unchanged
Policy array of two execute_steps still samples one
PlanStep.intent rejects execute_step
```

Expected: default Policy still sequential; loop is not a scheduler.

## Scenario 7 — memory read is not an observation (Phase 5)

Normative cases: `specs/memory-read-vs-observation.md` (rule) and
`specs/turn-trace-extensions.md` (optional compact telemetry).

```text
Learning calls mem.semantic.read
inbox.current does not gain an observation for that read
retrieved payload is not in TurnTrace
operator memory.read may record ids/counts (already exists)
optional extension is agent-opt-in; core does not auto-emit
invalid TurnTrace extension does not fail the turn
```

## Scenario 8 — harness fork (Phase 6)

Normative cases: `specs/harness-snapshot-fork.md`. PlanPatch:
`specs/plan-patch.md`.

```text
snapshot at failure
fork A = retry policy
fork B = repair policy (plan.patch → Learning apply)
mutating A does not change B.currentM() / traces / stub queues
wrong baseRevision → PLAN_PATCH_REVISION_MISMATCH
remove_step that would OOB cursor clamps; set_cursor 0 after prefix delete works
invalid patch observation → validation.failed; M unchanged
TaskEngine / EngineLocator is process-global — not isolation-safe
```
