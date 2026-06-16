# Implementation Status

Last updated: 2026-05-04.

## Production Code Added

- `packages/core/src/streaming/runtimeStreamEvents.ts`
  - Zod-first canonical runtime stream event schema.
  - Inferred public event and part types.
- `packages/core/src/streaming/projections.ts`
  - Public/debug filtering.
  - SSE and chat projection helpers.
- `packages/core/src/streaming/a2aMapper.ts`
  - Legacy A2A task status/artifact events to canonical runtime events.
- `packages/core/src/streaming/sessionEventMapper.ts`
  - Persisted working-memory session events to canonical runtime events.
  - Currently maps `task.tool_requested` / `task.tool_completed` to `tool.started` / `tool.completed`.
  - Maps `task.child_started` / `task.child_completed` / `task.child_failed` to `child.started` / `child.completed`.
  - Maps `task.child_input_required` to debug `child.message` with prompt parts.
- `packages/chat-bridge/src/internal/invokers/chatProjectionForwarder.ts`
  - Canonical chat projection events to `ChatSender` calls.
- `packages/chat-bridge/src/internal/invokers/a2aSseChatStream.ts`
  - SSE CloudEvent frames and canonical runtime SSE frames to canonical runtime events, chat projection, and `ResultPayload`.

## Production Code Changed

- `packages/core/src/context/StreamingContext.ts`
  - Artifact chunk completion no longer becomes task finality.
- `packages/core/src/api/sse/streamHandler.ts`
  - SSE closes only on terminal task status.
  - Memory store is now lazy and only required for replay.
  - `?visibility=debug` can stream canonical debug runtime events from live bus events and replayed session events.
- `packages/core/src/orchestration/api/ApiBinder.ts`
  - Async `requestTool` now persists and publishes canonical `tool.started` debug events.
  - `sendTaskToAgent` now persists and publishes canonical `child.started` debug events.
- `packages/core/src/orchestration/taskEngine.ts`
  - Tool completion now persists tool name/result preview and publishes canonical `tool.completed` debug events.
  - Child completion/failure now persists and publishes canonical `child.completed` debug events.
  - Child input-required now persists and publishes canonical `child.message` debug events.
  - Conversation service runtime publisher routes canonical conversation debug events onto task streams.
- `packages/core/src/internal/conversation/ConversationService.ts`
  - Thread and topic sends publish canonical `conversation.message.sent` for sender sessions.
  - Thread and topic deliveries publish canonical `conversation.message.received` for recipient sessions.
- `packages/core/src/streaming/cognitionRuntimePublisher.ts`
  - Wraps context cognition APIs and publishes canonical goal/thought/decision events after successful mutations.
  - Goal and decision previews are debug-visible; thoughts are private telemetry events.
- `packages/core/src/orchestration/A2AService.ts`
  - Child replies mirrored to parent task streams now also emit canonical debug `child.message` events.
  - Existing public artifact mirroring is preserved.
- `packages/core/src/api/rpc/tasksSubscribe.ts`
  - No eager memory SQL store creation for normal streaming.
- `packages/chat-bridge/src/internal/invokers/programmaticInvoker.ts`
  - Programmatic streaming now maps bus A2A events through canonical events and chat projection.
- `packages/chat-bridge/src/clients/jsonRpcInvoker.ts`
  - Optional streaming mode for `start()` via `tasks/sendSubscribe`.
  - Optional streaming mode for `resume()` via `tasks/resubscribe` plus `tasks/input`.
  - `startStream` / `resumeStream` expose canonical runtime events.
  - Compatibility `start` / `resume` can forward canonical events to `RuntimeStreamSink`.
- `packages/chat-bridge/src/internal/bridge.ts`
  - `Bridge` passes a canonical runtime sink into `Invoker.start` / `Invoker.resume`.
  - Streaming-capable invokers now let the bridge forward live chat messages, typing/progress, media, input-required, and terminal realtime events.
  - Invokers that ignore the sink still use the existing final `ResultPayload` fallback.

## Permanent Docs Promoted

- `apps/docs/17-runtime_streaming_contract.md`
  - Normative runtime streaming contract.
  - Support table for public/debug/private events, SSE, and chat bridge.
  - Finality rules for `artifact.done` vs terminal `task.status`.
  - Chat bridge sink/streaming invoker behavior.
  - References the runtime host example for live review.
- `apps/docs/drafts/chat/live-updates.md`
  - Rewritten to reference the canonical runtime streaming contract.
- `apps/docs/drafts/chat/overview.md` and `apps/docs/drafts/DOCUMENTATION_INDEX.md`
  - Cross-reference the runtime streaming contract.

## Disposable Manual Review Tool

- `apps/examples/runtime-host/`
  - Canonical local reference host for the shared runtime server shape.
  - Mounts the real core `/rpc` router and registers `streaming-demo-agent`.
  - Prints `RPC URL: http://127.0.0.1:8790/rpc`.
- `apps/docs/streaming-harness/viewer/`
  - Local browser viewer plus Node proxy for JSON-RPC SSE and direct SSE.
  - Supports `tasks/sendSubscribe`, `tasks/resubscribe`, `tasks/input`, public/debug visibility, event filtering, and terminal/public/debug counters.
  - Intentionally temporary; delete with the harness after manual review and final promotion.

## Tested

- Core canonical schema, projection, and A2A mapper tests.
- SSE closure regression tests for artifact completion vs task completion.
- `ctx.progress(...)` regression test proving percentage/message progress maps to non-terminal canonical `task.status`.
- Server-side `tasks/sendSubscribe` and `tasks/resubscribe` SSE integration tests.
- Legacy SSE replay test for numeric `Last-Event-ID` sequence cursor.
- Canonical session-event mapper tests for tool request/completion.
- Canonical session-event mapper tests for child start/completion/failure/input-required.
- SSE debug replay/live tests for canonical tool and child events.
- Conversation thread/topic tests for canonical sent/received debug runtime events.
- Cognition runtime publisher tests for `goal.changed`, `thought.added`, and `decision.added`.
- A2A child reply tests for canonical debug `child.message` plus existing public artifact mirroring.
- Chat bridge programmatic streaming tests for start, resume, input-required, and terminal completion.
- Chat bridge JSON-RPC streaming tests for start, resume, input-required, and terminal completion.
- Programmatic vs remote chat-visible parity test.
- Bridge-level live runtime sink test for chat and realtime projection.
- SSE helper tests for malformed frames, comments, multi-line data, canonical runtime frames, input-required, failed status, and missing terminal status.
- Disposable harness validators for positive fixtures, invalid fixtures, and projections.
- Disposable viewer syntax check with `node --check apps/docs/streaming-harness/viewer/server.mjs`.
- Runtime host build with `yarn workspace @a2arium/runtime-host build`.

## Remaining Gaps

- Public `StreamingInvoker` contract types exist, and `ProgrammaticInvoker` / `JsonRpcInvoker` implement `startStream` and `resumeStream`.
- Compatibility `Invoker.start` / `Invoker.resume` supports optional `RuntimeStreamSink`.
- `Bridge` now requests streaming through the optional `RuntimeStreamSink`; `JsonRpcInvoker({ streaming: true, chatSender })` remains a transitional direct-invoker path.
- Rich debug/private event schemas exist. Tool request/completion, child start/completion/failure/input-required/output-message, conversation sent/received, and goal/thought/decision producers are wired.
- Legacy SSE replay is documented and tested as numeric `Last-Event-ID` / `sinceSeq`.
- Versioned canonical replay with opaque event ids is not designed yet.
- Core accepted streaming contract is promoted to permanent root docs.
- Detailed ADRs and disposable validation fixtures remain in the harness until final cleanup.
- Manual live review should be performed with `apps/docs/streaming-harness/viewer/` before deleting ADRs/harness.
- Full `yarn build` passed on 2026-05-04 with `@a2arium/runtime-host` included.

## Promotion Criteria

- Keep both public streaming shapes: `StreamingInvoker` async iterables for direct streaming consumers, and optional `RuntimeStreamSink` on compatibility `Invoker.start` / `resume` for bridge integration.
- Review whether any detailed ADR/spec content still needs separate permanent docs beyond `17-runtime_streaming_contract.md`.
- Keep only production tests that remain useful after promotion.
- Delete `apps/docs/streaming-harness/` once all accepted content is promoted or intentionally discarded.
