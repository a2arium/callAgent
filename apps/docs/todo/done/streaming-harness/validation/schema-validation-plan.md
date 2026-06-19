# Schema Validation Plan

This plan describes the first disposable validation layer for the streaming
harness. It should be implemented before production runtime code changes.

## Goal

Prove that the canonical event model is:

- Zod-validated.
- Type-inferred from schemas.
- Closed and discriminated by `type`.
- Ordered by `seq`.
- Safe under public/debug/private projection.

## Inputs

Use deterministic NDJSON fixtures:

- `examples/simple-reply.events.ndjson`
- `examples/incremental-artifact.events.ndjson`
- `examples/input-required-resume.events.ndjson`

## Validation Steps

For each fixture:

1. Parse each line as JSON.
2. Validate each event with `RuntimeStreamEventSchema`.
3. Assert `seq` starts at `0`.
4. Assert `seq` increments by `1` for the fixture.
5. Assert every event has the same `taskId`.
6. Assert public projection contains only `visibility: public`.
7. Assert terminal closure happens only when:
   - `type === 'task.status'`
   - `data.terminal === true`
   - `data.state` is one of `completed | failed | canceled`
8. Assert `artifact.done` never closes the stream.
9. Assert no public event contains known private field names:
   - `rawPrompt`
   - `rawToolArgs`
   - `rawThought`
   - `rawMemory`
   - `unredactedTrace`

## Type Tests

When this becomes code, add compile-time tests that prove:

- `RuntimeStreamEvent` is inferred from `RuntimeStreamEventSchema`.
- Invalid event variants do not compile when authored as typed literals.
- Public projection does not expose private-only payload fields.

## Expected Commands

Future implementation may expose:

```bash
yarn workspace @a2arium/callagent-core test:types
yarn test packages/core/tests/runtimeStream.schemas.test.ts
```

During the disposable harness phase, a local script is acceptable as long as it
uses the same Zod schemas that production code will use.

Current disposable command:

```bash
yarn tsx apps/docs/streaming-harness/validation/validate-fixtures.ts
yarn tsx apps/docs/streaming-harness/validation/validate-negative-fixtures.ts
```
