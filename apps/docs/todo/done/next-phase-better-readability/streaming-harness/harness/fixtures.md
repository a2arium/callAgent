# Harness Fixtures

## Fixture Agents

Planned disposable fixtures:

- `simple-reply-agent`
- `incremental-reply-agent`
- `input-required-agent`
- `tool-await-agent`
- `child-parent-agent`
- `conversation-agent`
- `memory-events-agent`

## Fake Adapters

- Fake stream store with deterministic sequence ids.
- Fake SSE client with reconnect support.
- Fake chat sender writing `chat-sender.ndjson`.
- Fake tool executor.
- Fake child agent dispatcher.

## Determinism

- Stable task ids.
- Stable event ids where possible.
- Fixed timestamps or timestamp normalization in golden tests.
- Redacted payload snapshots for public projections.

