# conversation-reference-agent

Canonical **Phase 1 conversation thread** example: `startThread` with a stable thread id, delivery merged into the harness session inbox, a follow-up `send`, and idempotent replay.

Pair it with `apps/examples/conversation-responder-agent/` when you want an explicit two-agent setup.

Build: `yarn build`  
Tests: `yarn test` (golden harness in `tests/golden.test.ts`)

Trigger: user input `{ text: 'go' }` (see `tests/golden.test.ts`).

**Runner CLI:** pass JSON that becomes `payload.value` with a top-level `text` field, for example `'{"text":"go"}'`. The shape `'{"value":{"text":"go"}}'` is also accepted (same nesting as `hello-agent`’s `value` wrapper).
