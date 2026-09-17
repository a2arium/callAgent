# Root Documentation Compliance

This workspace is constrained by the root framework docs.

## Type Rules

Source: `apps/docs/todo/types-rules.md`

- Zod schemas are the source of truth.
- Exported TypeScript types must be inferred from schemas.
- Public APIs must not expose `any`.
- Illegal states must be unrepresentable where practical.
- Event unions must be closed and discriminated.

## APLRET Contract

Source: `apps/docs/0-aplret_contracts.md`

- Streaming must not bypass the turn pipeline.
- Effects still happen only in Execution.
- If data should affect Policy, it must enter cognition through observations,
  Perception, Learning, and `MentalState`.
- Control state and cognitive state remain separate.

## Observation Envelope

Source: `apps/docs/16-observation_envelope_and_validation.md`

- Runtime observations remain `source`, `kind`, `payload`, optional
  `provenance`.
- Stream events are not a replacement for observations.
- When stream events are derived from observations, the source observation must
  remain valid under the existing observation schema.

## Testing

Sources:

- `apps/docs/11-how_to_test_aplret_agents.md`
- `apps/docs/12-how_to_debug_with_turn_trace.md`

Required testing posture:

- Use turn-script style tests for runtime behavior.
- Use TurnTrace for debugging and effect-path assertions.
- Stream golden traces verify client-visible/projection behavior.
- Do not debug or test core behavior from chat output alone.

