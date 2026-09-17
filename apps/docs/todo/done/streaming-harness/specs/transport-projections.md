# Transport Projection Spec

## Rule

Transports project canonical runtime events. They do not define runtime
semantics.

## SSE Projection

- Serialize filtered runtime events as SSE data frames.
- Use event `id` as SSE `id`.
- Use event `type` as SSE `event`.
- Close only on terminal `task.status`.

## NDJSON Projection

- Write one canonical event JSON object per line.
- Preserve original ordering.
- Produce filtered files such as `public.ndjson` and `debug.ndjson`.

## CLI Projection

- Quiet structured mode should emit NDJSON or JSON only.
- Human console mode may render friendly text, but is not the contract.

