# Projection Test Plan

Projection tests verify that canonical runtime stream events map to transport
and client outputs without changing runtime semantics.

## Projection Targets

| Target | Test Output |
|---|---|
| Public NDJSON | `public.ndjson` |
| Debug NDJSON | `debug.ndjson` |
| SSE | ordered SSE frames |
| Chat bridge | fake `ChatSender` calls |
| CLI | quiet structured output |

## Public Projection Rules

- Include only `visibility: public`.
- Preserve `seq`, `id`, `taskId`, `ts`, and `type`.
- Do not include debug/private events.
- Do not close on `artifact.done`.
- Close only on terminal `task.status`.

## Debug Projection Rules

- Include `public` and `debug`.
- Exclude `private` unless explicitly configured.
- Preserve sequence order.
- Redacted previews are allowed.

## Chat Projection Rules

| Runtime Event | Fake Chat Sender Call |
|---|---|
| `task.status` working | `sendTyping(route)` |
| `artifact.delta` text | `sendMessage(route, text, parseMode)` |
| `artifact.delta` media | `sendMedia(route, media)` |
| `artifact.delta` markup | `sendMarkup(route, markup)` |
| `input.required` | `sendMessage` or `sendMarkup` depending on parts |
| terminal `task.status` completed | clear session, no required message |
| terminal `task.status` failed | send failure message |

## Current Disposable Command

```bash
yarn tsx apps/docs/streaming-harness/validation/validate-projections.ts
```

This command validates the current fixtures and checks public/debug/SSE/chat
projection invariants.

## SSE Projection Rules

- SSE `id` equals event `id`.
- SSE `event` equals event `type`.
- SSE `data` is the filtered event JSON.
- `Last-Event-ID` replay returns events after that id.
