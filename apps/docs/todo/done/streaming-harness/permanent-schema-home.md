# Permanent Schema Home

The harness schema is disposable. If accepted, the production schema should move
into core.

## Recommended Location

```text
packages/core/src/streaming/runtimeStreamEvents.ts
```

## Rationale

- Runtime stream events are core runtime contracts.
- They are shared by SSE, chat bridge, CLI, tests, and future viewers.
- They are not only A2A task events and should not live under a transport
  adapter folder.

## Expected Exports

```ts
export const RuntimeStreamEventSchema = ...
export type RuntimeStreamEvent = z.infer<typeof RuntimeStreamEventSchema>;

export const RuntimeStreamProjectionSchema = ...
export type RuntimeStreamProjection = z.infer<typeof RuntimeStreamProjectionSchema>;
```

## Related Permanent Test Location

```text
packages/core/tests/runtimeStreamEvents.schema.test.ts
packages/core/tests/runtimeStreamEvents.projection.test.ts
packages/chat-bridge/tests/streamingProjection.test.ts
```

## Migration Rule

Do not hand-copy exported TypeScript types. Move the Zod schemas first, then infer
public types from those schemas.

