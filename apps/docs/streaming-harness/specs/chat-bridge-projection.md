# Chat Bridge Projection Spec

## Goal

Chat bridge should consume the same canonical runtime stream as SSE and CLI.

JSON-RPC streaming remains compatible with legacy A2A CloudEvent SSE frames, but
the bridge also accepts canonical runtime SSE frames directly. Debug events are
yielded by `startStream` / `resumeStream`; chat projection ignores them unless a
future explicit debug chat mode is added.

## Projection Rules

| Runtime Event | Chat Projection |
|---|---|
| `task.status` working | `sendTyping` when supported, throttled. |
| `artifact.delta` text | `sendMessage` or buffer by channel policy. |
| `artifact.delta` media | `sendMedia`. |
| `artifact.delta` markup | `sendMarkup`. |
| `artifact.done` | usually no-op. |
| `input.required` | send prompt/buttons, persist token. |
| `task.status` completed | clear session. |
| `task.status` failed | send failure message, clear session. |
| debug/private events | hidden unless bridge is explicitly in debug mode. |

## Realtime Event Contract

Chat bridge public realtime events should be projected from canonical runtime
events instead of independently invented. The current `ChatEvent` union can be
kept as a projection type, but it should be derived from these rules:

```ts
type ChatEvent =
  | { type: 'reply'; taskId: string; seq: number; ts: string; text: string }
  | { type: 'progress'; taskId: string; seq: number; ts: string; pct?: number; status?: string }
  | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
  | { type: 'completed'; taskId: string; seq: number; ts: string; output?: unknown }
  | { type: 'error'; taskId: string; seq: number; ts: string; code?: string; message: string }
  | { type: 'media'; taskId: string; seq: number; ts: string; media: unknown };
```

Production types should be Zod-inferred and must not diverge from runtime
projection behavior.

## Invoker Contract Direction

Preferred:

```ts
type StreamingInvoker = {
  startStream(params: StartParams): AsyncIterable<RuntimeStreamEvent>;
  resumeStream(params: ResumeParams): AsyncIterable<RuntimeStreamEvent>;
};
```

Compatibility:

```ts
type Invoker = {
  start(params: StartParams, sink?: StreamSink): Promise<ResultPayload>;
  resume(params: ResumeParams, sink?: StreamSink): Promise<ResultPayload>;
};
```
