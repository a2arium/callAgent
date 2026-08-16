# Planning Model POC Scenarios

These scenarios validate the planning model before production schema changes
are treated as done. They are intentionally small and deterministic. Expand
each with exact fixtures when the matching spec is written.

Gates refer to the testing principles in `../testing-principles.md`.

## Scenario 0 — schema truth

Purpose: prove docs and `PlanSchema` are the same type.

```text
parse a sequential plan with title, cursor, intent, no dependsOn
reject cursor out of bounds
reject create_plan as a step intent
reject unknown action-kind on step
```

Expected: Phase 1 schema tests green; contracts examples parse.

## Scenario 1 — missing / self / cycle

Purpose: graph validation is loud and structured.

```text
dependsOn references a missing id → error code
step depends on itself → error code
A→B→C→A → cycle error code
```

Expected: `validatePlanGraph` never throws unstructured strings.

## Scenario 2 — two ready steps

Purpose: DAG readiness without a loop scheduler.

```text
steps A and B have no deps, C depends on A and B
ready = [A, B]
blocked = [C]
complete A → ready = [B], blocked = [C]
```

Expected: helpers only; Policy still emits one intent.

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

Purpose: optional validation gate (Phase 3).

```text
A completed, validation pending
requireValidatedDependencies = true → C not ready
A validation valid → C ready
```

## Scenario 5 — output refs, not payloads

Purpose: artifact rule on steps.

```text
step completion writes outputs: [{ kind: 'artifact', ref }]
PlanSchema rejects a large inline result blob
refs survive snapshot/resume
```

## Scenario 6 — execute_step (Phase 4)

```text
A and B ready
Policy emits execute_step(planId, A)
B remains pending/ready
next turn Policy may emit execute_step(planId, B)
```

## Scenario 7 — memory read is not an observation (Phase 5)

```text
Learning calls mem.semantic.read
TurnTrace / operator memory.read records ids/counts
inbox.current does not gain a new observation for that read
```

## Scenario 8 — harness fork (Phase 6)

```text
snapshot at failure
fork A = retry policy
fork B = repair policy
mutating A does not change B.currentM()
```
