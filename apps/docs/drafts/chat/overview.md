# Chat Bridge Overview

Explains multi-network chat integration: start vs resume routing, session mapping, idempotency, and realtime.

- Conversation key: `${network}:${conversationId}`
- Session record: `{ agentId, taskId, state, token?, lastActivityAt, lastEventSeq? }`
- Agent input payload: `BridgeTaskInput` wraps normalized text/attachments and a `route { network, conversationId, userId? }` so agents can read `ctx.task.input.route` for channel metadata (including `userId`)
- States: idle → running → input_required → running → completed/failed
- Idempotency: use provider messageId; store `${key}:${messageId}`
- Realtime: optional publisher to `channelKey = key`; live events are projected
  from canonical runtime stream events

See:

- [Runtime Streaming Contract](../../17-runtime_streaming_contract.md)
- [Live Updates](./live-updates.md)
- `packages/chat-bridge/README.md` for types and API.
