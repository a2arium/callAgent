# Chat Bridge Overview

Explains multi-network chat integration: start vs resume routing, session mapping, idempotency, and realtime.

- Conversation key: `${network}:${conversationId}`
- Session record: `{ agentId, taskId, state, token?, lastActivityAt, lastEventSeq? }`
- States: idle → running → input_required → running → completed/failed
- Idempotency: use provider messageId; store `${key}:${messageId}`
- Realtime: optional publisher to `channelKey = key`; events use a simple ChatEvent schema

See `packages/chat-bridge/README.md` for types and API.
