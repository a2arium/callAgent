# Migration Compatibility Spec

## Existing Behavior To Preserve

- `ctx.reply(...)` continues to produce user-visible output.
- `ctx.progress(...)` continues to produce working/progress status.
- `requestInput(...)` continues to prompt and return a token.
- Existing `tasks/send` remains buffered.
- Existing `tasks/sendSubscribe` remains SSE-compatible.

## Compatibility Projection

During migration, existing A2A task events can be projected into canonical
runtime stream events. New canonical events can then be projected back into
legacy A2A/SSE shapes where needed.

## Breaking Change Avoidance

- Do not remove existing public APIs until equivalent canonical projections are
  tested.
- Add new stream contracts beside current invoker contracts first.
- Keep feature flags for debug/private event exposure.

