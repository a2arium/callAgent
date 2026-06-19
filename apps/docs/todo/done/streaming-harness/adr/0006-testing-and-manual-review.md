# ADR 0006: Testing And Manual Review

## Status

Proposed

## Context

CLI output is noisy and a full web viewer is too expensive before the event
contract is stable.

## Decision

Use structured NDJSON traces and a minimal disposable SSE viewer for manual
review. Automated tests assert schemas, ordering, projections, replay, closure
behavior, and leak prevention.

The disposable viewer lives in `apps/docs/streaming-harness/viewer/`. It serves a
small browser UI and a local proxy so reviewers can test JSON-RPC SSE endpoints
without browser CORS or `EventSource` POST limitations.

Manual review command:

```bash
node apps/docs/streaming-harness/viewer/server.mjs
```

Open `http://127.0.0.1:8787`, point the RPC endpoint to a running API server,
and use `tasks/sendSubscribe`, `tasks/resubscribe`, or direct SSE mode.

## Consequences

- Manual review is possible before a full UI exists.
- Golden traces can become permanent regression tests.
- CLI remains a smoke surface until quiet structured mode exists.
- The viewer is not a supported product surface and should be deleted with the
  harness after promotion.
