# conversation-reference-agent — flow

## Intents (internal)

- `conversation_demo_open` — `ctx.conversation.startThread` with fixed `conversationId` `thread-conv-ref-1` and first `request` message to `conversation-responder-agent`.
- `conversation_demo_follow_up` — two `send` calls with the same `idempotencyKey` so the second returns `dedupeHit: true`.

## Observations

- **User** `input.provided` with `{ text: 'go' }` seeds `demoStage: want_open`.
- **Conversation** `message.received` for `thread-conv-ref-1` sets `demoStage: want_followup` so policy can issue the follow-up intent on the next turn.

## Stages

1. Turn 1 — open thread; transition `continue`.
2. Turn 2 — follow-up + idempotent replay; transition `complete` with `{ lastDedupeHit: true }`.
