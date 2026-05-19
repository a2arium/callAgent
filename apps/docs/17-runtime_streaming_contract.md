# Runtime Streaming Contract

## Status

Normative reference for live runtime streaming in the callagent framework.

This document defines what can be streamed to clients, which stream surfaces are
public, and how canonical runtime stream events relate to existing A2A SSE and
chat bridge behavior.

## Purpose

Runtime streaming gives clients live execution facts without creating a second
cognition path. Streams are projections of runtime, session, conversation,
artifact, and cognition facts. They do not let clients observe future turns, skip
APLRET observations, or read private reasoning by default.

The canonical production schema lives in:

- `packages/core/src/streaming/runtimeStreamEvents.ts`
- `packages/core/src/streaming/projections.ts`
- `packages/core/src/streaming/a2aMapper.ts`
- `packages/core/src/streaming/sessionEventMapper.ts`

Runtime validation and TypeScript types are Zod-first. Public API types are
inferred from those schemas.

## Core Principles

- Canonical runtime stream events are a closed discriminated union.
- Public clients receive only `visibility: 'public'` unless a debug stream is
  explicitly requested.
- Debug streams may include tool, child, conversation, goal, and decision
  lifecycle metadata, but still exclude `visibility: 'private'`.
- Private events are telemetry/debug material and must not be sent to normal
  clients.
- LLM token streaming from inference is not a supported public stream surface.
  The schema has `llm.*` debug/private event capacity, but agent-visible output
  should stream as artifacts/messages after the runtime chooses to publish it.
- `artifact.lastChunk` means the artifact is complete. It does not mean the task
  is complete.
- SSE and chat bridge streams close only on terminal `task.status` events.

## Event Support Table

| Runtime fact | Canonical event | Visibility | Public SSE | Debug SSE | Chat bridge | Notes |
|---|---|---:|---:|---:|---:|---|
| Task submitted/working/progress | `task.status` | public | yes | yes | progress/typing | `ctx.progress(...)` maps to non-terminal `task.status` with progress metadata. |
| Task completed | `task.status` | public | yes | yes | completed | Terminal only when state is `completed` and `terminal: true`. |
| Task failed/canceled | `task.status` | public | yes | yes | error | Terminal only when failed/canceled and `terminal: true`. |
| Artifact text/media/markup chunk | `artifact.delta` | public | yes | yes | reply/media/markup | Produced by `ctx.reply(...)` and legacy artifact events. |
| Artifact completion | `artifact.done` | public | yes | yes | no-op | Derived from `artifact.lastChunk`; never task finality. |
| Input request | `input.required` | public | yes | yes | input_required | Carries token and prompt parts when available. |
| Normalized output message | `message.output` | public | yes | yes | reply/media | Optional normalized user-facing projection. |
| Tool started | `tool.started` | debug | no | yes | hidden | Published from tool request runtime paths. |
| Tool completed/failed | `tool.completed` | debug | no | yes | hidden | Includes status and preview/error metadata. |
| Child/subagent started | `child.started` | debug | no | yes | hidden | Published when a child task is dispatched. |
| Child/subagent message | `child.message` | debug/public | public only if marked public | yes | hidden by default | Parent artifact mirroring remains the public output path. |
| Child/subagent completed/failed | `child.completed` | debug | no | yes | hidden | Includes result preview or error metadata. |
| Conversation sent | `conversation.message.sent` | debug | no | yes | hidden | Thread/topic sender-side runtime event. |
| Conversation received | `conversation.message.received` | debug | no | yes | hidden | Thread/topic recipient-side runtime event; includes `speechAct`. |
| Goal changed | `goal.changed` | debug/private | no | debug only | hidden | Published after successful cognition API mutation. |
| Thought added | `thought.added` | private/debug | no | debug only if marked debug | hidden | Private by default for reasoning safety. |
| Decision added | `decision.added` | debug/private | no | debug only | hidden | Published after successful decision mutation. |
| Turn trace summary | `trace.summary` | debug | no | yes | hidden | Compact observability projection; TurnTrace remains authoritative. |
| LLM call lifecycle | `llm.started`, `llm.completed` | debug | no | yes when produced | hidden | Debug metadata only. |
| LLM token/chunk delta | `llm.delta` | debug/public schema capacity | not supported as public inference streaming | debug only when produced | hidden | Do not expose raw inference as normal user output. |

## Canonical Event Envelope

Every event has:

```ts
{
  version: '2026-05-02',
  id: string,
  seq: number,
  taskId: string,
  ts: string,
  visibility: 'public' | 'debug' | 'private',
  type: string,
  data: unknown
}
```

Optional correlation fields include `tenantId`, `agentId`, `parentTaskId`,
`traceId`, and `spanId`.

Use `id` for transport/event identity and `seq` for ordering within a task
stream. Current legacy SSE replay supports numeric `Last-Event-ID` as a sequence
cursor. Opaque canonical replay ids are not yet a stable public contract.

## Transports

The local reference host for manual review lives in
`apps/examples/runtime-host`. It demonstrates the shared runtime-host shape by
mounting the real `createApiRouter()` at `/rpc`, loading a demo agent, and using
the same `TaskEngine`/SSE projection path as production adapters.

Start it with:

```bash
yarn workspace @a2arium/runtime-host dev
```

The default local RPC URL is:

```text
http://127.0.0.1:8790/rpc
```

### Legacy A2A SSE

`tasks/sendSubscribe` and `tasks/resubscribe` preserve the existing CloudEvent
SSE shape for compatibility. Existing clients still see A2A task status and
artifact events.

Internally, those events are mapped to canonical runtime events to decide stream
closure and projection behavior. This is why `artifact.lastChunk` no longer
closes the stream.

### Canonical SSE

When a canonical runtime event is published to the task bus, SSE can write it as
an SSE frame:

```text
id: <event.id>
event: <event.type>
data: <canonical runtime event json>
```

By default only public events are written. `?visibility=debug` includes public
and debug events. Private events remain excluded.

### Chat Bridge

The chat bridge consumes canonical runtime events through two compatible APIs:

- `StreamingInvoker.startStream(...)` / `resumeStream(...)` return
  `AsyncIterable<RuntimeStreamEvent>`.
- Compatibility `Invoker.start(...)` / `resume(...)` accept an optional
  `RuntimeStreamSink`.

`Bridge` passes a runtime sink into `start` and `resume`, so streaming-capable
invokers can deliver live events to chat and realtime clients. Invokers that
ignore the sink still work through the final `ResultPayload` fallback.

Chat projection rules:

| Runtime event | Chat behavior |
|---|---|
| `task.status` working | typing/progress |
| `artifact.delta` text | send message |
| `artifact.delta` media | send media |
| `artifact.delta` markup | send markup |
| `input.required` | store token and prompt user |
| terminal `task.status` completed | clear running session and publish completion |
| terminal `task.status` failed/canceled | publish error and clear session |
| debug/private events | hidden |

Realtime publisher events are projected from the same canonical events:

```ts
type ChatEvent =
  | { type: 'reply'; taskId: string; seq: number; ts: string; text: string }
  | { type: 'progress'; taskId: string; seq: number; ts: string; pct?: number; status?: string }
  | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
  | { type: 'completed'; taskId: string; seq: number; ts: string; output?: unknown }
  | { type: 'error'; taskId: string; seq: number; ts: string; code?: string; message: string }
  | { type: 'media'; taskId: string; seq: number; ts: string; media: unknown };
```

## Finality

There are two independent completion concepts:

- Artifact completion: `artifact.done`.
- Task completion: terminal `task.status`.

Only terminal `task.status` closes task streams.

Examples:

- `ctx.reply('done', { lastChunk: true })` emits an artifact delta/done, but the
  task may still request input, call tools, delegate to a child, or emit a final
  status later.
- `ctx.progress(50, 'Working')` emits a public, non-terminal `task.status`.
- `ctx.complete()` or runtime completion emits terminal `task.status` and closes
  the stream.

## Debug And Privacy

Public streams must not include raw prompts, raw thoughts, unredacted tool args,
raw memory, or private turn traces.

Debug streams are intended for operators and developers. They can include
execution lifecycle metadata such as:

- tool calls
- child/subagent calls
- conversation routing
- goal/decision previews
- trace summaries

Private streams are not a client contract. They may be used for internal
telemetry, local debugging, or future privileged inspection tools.

## Testing Contract

Streaming behavior is covered by:

- schema tests for valid and invalid canonical events
- projection tests for public/debug/SSE/chat visibility
- finality regression tests for `lastChunk` vs terminal task status
- `ctx.progress` mapping tests
- SSE integration tests for `tasks/sendSubscribe` and `tasks/resubscribe`
- chat bridge programmatic/JSON-RPC streaming tests
- bridge-level runtime sink tests
- conversation, cognition, child, and tool debug producer tests

The temporary harness under `apps/docs/streaming-harness/` contains migration
fixtures and validation scripts. It can be deleted only after accepted content is
fully promoted or intentionally discarded.
