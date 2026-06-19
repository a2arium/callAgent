# Testing Principles

## Test Layers

| Layer | Purpose |
|---|---|
| Schema tests | Validate every event shape. |
| Golden trace tests | Assert ordered scenario event sequences. |
| Visibility tests | Ensure public streams do not leak debug/private data. |
| Projection tests | Verify canonical events map to SSE, chat, CLI, and NDJSON correctly. |
| Replay tests | Verify reconnect from a sequence/event id returns missed events. |
| Closure tests | Verify only terminal task status closes a stream. |
| Chat bridge parity tests | Verify programmatic and remote streaming invokers produce equivalent chat events. |
| Type tests | Verify public event contracts infer from Zod schemas and reject illegal states. |

## Contract Testing Rules

- Schema definitions must be authored in Zod first.
- TypeScript event types must be inferred from schemas.
- Tests must validate both accepted and rejected payloads.
- Golden traces should assert compact, stable fields first: `seq`, `type`,
  `visibility`, key payload discriminants, and terminal behavior.
- Do not snapshot raw chat output as the primary proof.
- Do not snapshot private payloads in public golden traces.

## Manual Review Surfaces

Primary manual review should use structured outputs, not noisy CLI logs.

| Surface | Purpose |
|---|---|
| `events.ndjson` | Canonical event trace for diffing and review. |
| `public.ndjson` | What normal clients can see. |
| `debug.ndjson` | Debug-visible events for developer review. |
| `chat-sender.ndjson` | Fake chat sender calls for chat projection review. |
| Minimal SSE/NDJSON viewer | Human inspection of live order, timing, visibility, and replay. |

CLI is a smoke surface only until it has a quiet structured streaming mode.

## Manual Questions

1. Did the runtime emit correct facts?
2. Did each client projection expose the right subset?
3. Did reconnect/replay preserve ordering and avoid duplicates?
4. Did public output avoid private/internal leakage?
5. Did chat projection behave naturally without requiring a real Telegram/Slack integration?
