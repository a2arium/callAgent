# Testing Principles

Planning work extends the existing turn-script model. It does not invent a
second harness. See `apps/docs/11-how_to_test_aplret_agents.md`.

## Test layers

| Layer | Purpose |
|---|---|
| Schema tests | `PlanSchema` / `PlanStepSchema` accept and reject the decided shape. |
| Type tests | Inferred types match the spec; illegal step intents do not compile or parse. |
| Helper tests | Pure `validatePlanGraph` / ready / blocked / lookup cases (`planGraph.test.ts`). |
| Turn scripts | create plan → execute step → repair → resume after tool/child. |
| Snapshot tests | refs, lineage, and meta survive serialize/resume. |
| Isolation tests | (Phase 6) two harness forks do not share mutable state. |

## Contract testing rules

- Zod is the authority. TypeScript types are inferred.
- Tests must include rejected payloads (missing dependency, self-edge, cycle,
  planning intent on a step, cursor out of bounds, leftover `description` /
  `result` / action-kind, non-JSON `meta`).
- Duplicate ids in one `dependsOn` list (and Phase 3 `validation.refs`)
  **parse**. Assert uniquify as one edge / one ref; do not add a reject
  case for `['A','A']`.
- Invalid plan observations must assert `internal/validation.failed`, not a
  silent drop.
- Phase 1 schema cases live in `packages/core/tests/planning.model.test.ts`
  as specified by `specs/plan-schema.md`. Type cases live in
  `packages/core/tests/plan.types.test-d.ts` (`yarn test:types`). Do not add
  a second schema-test file or a second type-test runner. Expected fixture
  failures after `description` → `title` are updates, not a reason to
  restore the old field.
- Phase 2 helper cases live in `packages/core/tests/planGraph.test.ts` as
  specified by `specs/plan-graph-helpers.md`. Add tsd cases to the same
  `plan.types.test-d.ts`. Do not dump helper tests into
  `planning.model.test.ts`. Do not loosen Phase 1 schema reject cases to
  make helpers pass.
- Phase 3 schema fields stay in `planning.model.test.ts`; the validation
  flag cases stay in `planGraph.test.ts`. Default ready tests MUST keep
  Phase 2 meaning when options are omitted.
- Phase 4 turn scripts: `planning.execute-step.test.ts`. Exhaustive
  `Intent` switches are updates, not a reason to open `kind` to `string`.
  Required: pending stamp (`planId`/`stepId`/`advanceCursor`); default
  Learning completes the named step from `tool.completed`; a blocked but
  named pending step still dispatches (Execution does not check
  `dependsOn`); kind-parity of core vs memory-engine scaffold.
- Phase 5: `turnTrace.extensions.test.ts` and
  `memory-read-not-observation.test.ts`. Do not log retrieved payloads.
- Phase 6: `planPatch.test.ts` and `testHarness.fork.test.ts`. Do not
  loosen Phase 1 `plan.updated` (full Plan) to accept a patch. Required:
  `remove_step` that would OOB `cursor` clamps; explicit `set_cursor`
  past `steps.length` fails; EngineLocator is not isolation-safe.
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
  still parse fixtures through `PlanSchema`. Jest ESM: `@jest/globals`, `.js`
  specifiers. Ready/blocked tests MUST include the cursor-only “all pending
  ready” case so we do not “fix” it by teaching helpers to read `cursor`.
- Isolation tests (Phase 6) clone with `structuredClone`; do not share
  stub queues or `ctx` across forks. Stateful module objects are a test
  pitfall, not a reason to skip isolation asserts.

## Manual review questions

1. Do contracts, spec, how-to, and `plan.ts` describe the same type?
2. Can a sequential agent still run with only `cursor` + `execute_next_step`?
3. Can a DAG agent select among two ready steps without a loop scheduler?
   (Helpers ignore `cursor`; sequential Policy still uses it.)
4. Are step outputs references, not inline blobs?
5. Did a durable memory read appear as a new inbox observation? (It must not.)
