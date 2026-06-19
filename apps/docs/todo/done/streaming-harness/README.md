# Streaming Harness Workspace

This is a temporary design and validation workspace for the live streaming model.
It exists to define the event contract, adapter projections, ADRs, and test
strategy before production runtime changes are made.

Delete this folder only after:

- Accepted specs have been promoted into permanent docs.
- Accepted ADRs have been moved or referenced from permanent architecture docs.
- Harness scenarios have been converted into permanent automated tests.
- Any disposable viewer or scripts have either been removed or promoted.

## Scope

This workspace covers:

- Canonical runtime stream events.
- Public/debug/private visibility.
- Artifact delta and completion semantics.
- SSE, chat bridge, CLI, and NDJSON projections.
- Manual review workflow.
- Automated contract and projection testing strategy.

This workspace does not implement production streaming behavior directly.

## Normative Inputs

The design in this workspace must comply with:

- `apps/docs/todo/types-rules.md`
- `apps/docs/0-aplret_contracts.md`
- `apps/docs/11-how_to_test_aplret_agents.md`
- `apps/docs/12-how_to_debug_with_turn_trace.md`
- `apps/docs/16-observation_envelope_and_validation.md`

In particular:

- Zod schemas are the source of truth for event validation and inferred types.
- Runtime stream event types must be closed discriminated unions.
- Streaming events are observability/output facts, not a second cognition path.
- Effects still belong in Execution.
- TurnTrace remains the primary debugging artifact for turn reasoning.

## Contents

- `principles.md` - design principles and non-negotiables.
- `testing-principles.md` - automated and manual testing strategy.
- `implementation-plan.md` - staged implementation plan.
- `production-start-plan.md` - first production implementation target.
- `permanent-schema-home.md` - recommended permanent schema location.
- `migration-checklist.md` - promotion checklist from harness to production.
- `adr/` - decision records to review before implementation.
- `specs/` - event and projection specs.
- `harness/` - disposable scenario and fixture plans.
- `examples/` - deterministic NDJSON traces for schema/projection validation.
- `validation/` - disposable validation and projection test plans.

Start with `specs/root-doc-compliance.md` when reviewing this workspace against
the rest of the framework documentation.

## Current Validation Command

```bash
yarn tsx apps/docs/streaming-harness/validation/validate-fixtures.ts
yarn tsx apps/docs/streaming-harness/validation/validate-negative-fixtures.ts
yarn tsx apps/docs/streaming-harness/validation/validate-projections.ts
```

The first command validates the example NDJSON traces against
`validation/runtimeStreamEvent.schema.ts` and checks ordering, task id stability,
terminal closure rules, visibility, and obvious public leak fields. The second
proves intentionally invalid fixtures fail. The third checks public/debug/SSE/chat
projection invariants.
