# Testing Principles

Planning work extends the existing turn-script model. It does not invent a
second harness. See `apps/docs/11-how_to_test_aplret_agents.md`.

## Test layers

| Layer | Purpose |
|---|---|
| Schema tests | `PlanSchema` / `PlanStepSchema` accept and reject the decided shape. |
| Type tests | Inferred types match the spec; illegal step intents do not compile or parse. |
| Helper tests | Pure `validatePlanGraph` / ready / blocked / cycle cases. |
| Turn scripts | create plan → execute step → repair → resume after tool/child. |
| Snapshot tests | refs, lineage, and meta survive serialize/resume. |
| Isolation tests | (Phase 6) two harness forks do not share mutable state. |

## Contract testing rules

- Zod is the authority. TypeScript types are inferred.
- Tests must include rejected payloads (missing dependency, self-edge, cycle,
  planning intent on a step, cursor out of bounds).
- Turn scripts assert TurnTrace: `internal/plan.*` in inbox, Learning hash
  change, Policy intent only after Learning write.
- Do not assert raw LLM JSON as the plan truth; assert the parsed, validated
  `M.plans` object.
- Do not put retrieved memory payloads in traces or golden files.

## Harness rules

- Use `createTestHarness` / turn scripts. Do not build ad-hoc `ctx: any`.
- Seed plans through `seedMentalState` or through observations, never by
  writing `M` from Policy.
- Deterministic LLM/tool stubs for plan generation and step effects.
- Graph helper tests may be pure unit tests with fixture `Plan` objects; they
  still parse fixtures through `PlanSchema`.

## Manual review questions

1. Do contracts, spec, how-to, and `plan.ts` describe the same type?
2. Can a sequential agent still run with only `cursor` + `execute_next_step`?
3. Can a DAG agent select among two ready steps without a loop scheduler?
4. Are step outputs references, not inline blobs?
5. Did a durable memory read appear as a new inbox observation? (It must not.)
