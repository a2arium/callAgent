# Observation Envelope and Validation

This page defines the canonical observation envelope shape used by the loop runtime.

## Required envelope

Every observation must include:

- `source`: one of `user | tool | child | internal | env | conversation`
- `kind`: source-specific event kind
- `payload`: source/kind-specific object payload
- `provenance` (optional): metadata such as `{ ts, turn }`

## Source and kind reference

The runtime validates envelopes with `ObservationSchema` from `packages/core/src/types/observation.ts`.
Use that file as the source of truth when adding new kinds.

Common examples:

```ts
{ source: 'user', kind: 'input.provided', payload: { token: 'tok', value: { text: 'hello' } } }
{ source: 'tool', kind: 'tool.completed', payload: { token: 'tok', result: { ok: true } } }
{ source: 'child', kind: 'child.completed', payload: { token: 'tok', result: { ok: true } } }
{ source: 'internal', kind: 'validation.failed', payload: { reason: 'invalid_observation_envelope' } }
{ source: 'env', kind: 'event.received', payload: { eventType: 'clock.tick' } }
{ source: 'conversation', kind: 'message.received', payload: { message: { id: 'm1' } } }
```

## What happens on invalid envelopes

`normalizeObservationInbox` validates each raw inbox row with `ObservationSchema.safeParse`.
If parsing fails, the runtime injects:

```ts
{
  source: 'internal',
  kind: 'validation.failed',
  payload: {
    reason: 'invalid_observation_envelope',
    zodError: ...,
    originalPayload: ...
  }
}
```

This allows Perception/Learning to handle schema failures as data rather than throwing.

## Debugging invalid envelopes

- By default, runtime logger warns when envelope validation fails.
- Set `CALLAGENT_DEBUG_INBOX=1` to emit extra debug details (`zodError` and `originalPayload`) for each failed row.

## Related guides

- `apps/docs/12-how_to_debug_with_turn_trace.md`
- `apps/docs/11-how_to_test_aplret_agents.md`
- `apps/docs/0-aplret_contracts.md`
