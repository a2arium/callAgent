# Live Updates (Realtime)

Two options:

- SSE: stream events over EventSource (server-hosted SSE).
- WebSockets via broker (e.g., Ably): publish ChatEvents to `channelKey = ${network}:${conversationId}` and subscribe from client.

Bridge publishes `input_required`, `completed`, and `error` when a RealtimePublisher is provided.
