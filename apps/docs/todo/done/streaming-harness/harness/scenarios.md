# Harness Scenarios

Each scenario should produce:

- `events.ndjson`
- `public.ndjson`
- `debug.ndjson`
- `chat-sender.ndjson`
- `summary.json`

## Scenarios

| Scenario | Required Evidence |
|---|---|
| simple reply | task status, artifact output, terminal status. |
| incremental artifact | multiple deltas, artifact done, terminal task status later. |
| LLM token stream | LLM debug events and public artifact deltas if relayed. |
| input required and resume | prompt, token, resumed output, completion. |
| async tool | debug tool started/completed, no public leak. |
| child agent | child started/message/completed, parent continuation. |
| conversation post | debug conversation event, no public leak by default. |
| goal and thought changes | debug/private events only. |
| reconnect replay | replay from sequence returns missed events once. |
| chat projection | fake sender receives expected calls. |

## First Golden Fixtures

The first fixtures are intentionally public-only so closure, ordering, and
artifact semantics can be validated before debug/private projections are added.

| Fixture | Scenario |
|---|---|
| `../examples/simple-reply.events.ndjson` | simple reply |
| `../examples/incremental-artifact.events.ndjson` | incremental artifact |
| `../examples/input-required-resume.events.ndjson` | input required and resume |
| `../examples/tool-debug-private.events.ndjson` | async tool plus private thought filtering |
