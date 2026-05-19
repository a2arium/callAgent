# Runtime Event Envelope Spec

## Draft Schema

```ts
import { z } from 'zod';

export const StreamVisibilitySchema = z.enum(['public', 'debug', 'private']);
export const StreamChannelSchema = z.enum(['user', 'debug', 'telemetry']);

export const RuntimeStreamEnvelopeBaseSchema = z.object({
  version: z.literal('2026-05-02'),
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  tenantId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  ts: z.string().datetime(),
  visibility: StreamVisibilitySchema,
  channel: StreamChannelSchema.optional(),
}).strict();
```

Concrete event schemas extend this base and add a literal `type` plus typed
`data`. Public runtime types must be inferred from the concrete schemas.

## Requirements

- `seq` is monotonic per task.
- `id` is stable for replay and dedupe.
- `visibility` is mandatory.
- `type` must be a literal discriminant in a closed Zod discriminated union.
- Terminal stream closure is represented only by terminal `task.status`.
- `data` must be typed by event kind. Do not use `z.any()`.
