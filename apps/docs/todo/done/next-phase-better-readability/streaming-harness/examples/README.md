# Example Event Traces

These NDJSON files are deterministic examples for the disposable streaming
harness. They are not production output yet.

Each line is one canonical runtime stream event.

## Files

- `simple-reply.events.ndjson`
- `incremental-artifact.events.ndjson`
- `input-required-resume.events.ndjson`
- `tool-debug-private.events.ndjson`

## Intended Use

- Validate schema shape.
- Validate ordering.
- Validate closure semantics.
- Validate public projection.
- Validate debug/private filtering.
- Seed future golden tests.
