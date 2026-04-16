# conversation-reference-agent

Canonical **Phase 1 conversation thread** example: `startThread` with a stable thread id, delivery merged into the harness session inbox, a follow-up `send`, and idempotent replay.

Pair it with `apps/examples/conversation-responder-agent/` when you want an explicit two-agent setup.

Build: `yarn build`  
Tests: `yarn test` (golden harness in `tests/golden.test.ts`)

Trigger: user input `{ text: 'go' }` (see `tests/golden.test.ts`).
