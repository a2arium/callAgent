# Live Updates

The chat bridge receives live task updates from the canonical runtime stream.
The normative streaming contract is
[Runtime Streaming Contract](../../17-runtime_streaming_contract.md).

## Delivery Options

- SSE from task endpoints such as `tasks/sendSubscribe` and `tasks/resubscribe`.
- Programmatic streaming through `StreamingInvoker.startStream(...)` and
  `resumeStream(...)`.
- Compatibility streaming through `Invoker.start(..., sink)` and
  `Invoker.resume(..., sink)`.
- Realtime broker publishing through `RealtimePublisher` using
  `channelKey = ${network}:${conversationId}`.

## Bridge Behavior

`Bridge` passes a canonical runtime sink to invokers. Streaming-capable invokers
call the sink as runtime events arrive. The bridge then projects public runtime
events into chat sends and realtime `ChatEvent`s.

Invokers that ignore the sink are still supported. In that case the bridge uses
the final `ResultPayload` fallback.

## Realtime Events

```ts
type ChatEvent =
  | { type: 'reply'; taskId: string; seq: number; ts: string; text: string }
  | { type: 'progress'; taskId: string; seq: number; ts: string; pct?: number; status?: string }
  | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
  | { type: 'completed'; taskId: string; seq: number; ts: string; output?: unknown }
  | { type: 'error'; taskId: string; seq: number; ts: string; code?: string; message: string }
  | { type: 'media'; taskId: string; seq: number; ts: string; media: unknown };
```

## Projection Rules

| Runtime event | Chat/realtime behavior |
|---|---|
| `task.status` working | typing/progress |
| `artifact.delta` text | message/reply |
| `artifact.delta` media | media |
| `artifact.delta` markup | markup |
| `input.required` | prompt user and store token |
| terminal `task.status` completed | completion and session clear |
| terminal `task.status` failed/canceled | error and session clear |
| debug/private events | hidden |

`ctx.progress(...)` maps to public non-terminal `task.status` and can become a
`progress` realtime event. `artifact.lastChunk` maps to artifact completion only;
the stream closes only on terminal task status.
