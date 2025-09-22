# Setup & Examples

## Serverless webhook

- Deploy `apps/functions/chat-webhook` and point your chat adapters to it.
- Body should be a normalized message:

```json
{
  "network": "telegram",
  "conversationId": "<chat-id>",
  "userId": "<user-id>",
  "messageId": "<provider-update-id>",
  "text": "hello"
}
```

## JSON-RPC (optional)

- Deploy `apps/functions/rpc` and call methods:
  - `tasks/send` `{ id, input, tenantId? }`
  - `tasks/input` `{ id, token, input, tenantId?, idempotencyKey? }`

## Realtime (Ably example)

- Use `AblyPublisher` and set `channelKey = ${network}:${conversationId}`.
- Client subscribes to that channel and renders ChatEvents.

## Web client example

See `apps/examples/web-chat/index.html` for a minimal SSE/HTTP pattern you can adapt.
