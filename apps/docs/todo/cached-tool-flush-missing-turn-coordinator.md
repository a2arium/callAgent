# Bug Report: Cached tool completion logs a missing turn coordinator flush failure

> **Status:** Open
>
> **Severity:** Low. The authoritative task completes correctly, but a successful
> cached-tool path emits an error-level durability diagnostic.

## Summary

After CallAgent commit `2c661ee`, SQL-backed loop tasks complete and publish their
authoritative terminal result correctly. During host parsing scenarios that reuse
a cached `fetch-html` result, `FlushScheduler` still logs a failed flush because
the corresponding task-turn coordinator state is missing.

The task subsequently completes with the correct `kind: 'complete'` application
result. This is not a terminal-delivery regression, but an error-level log on a
successful path can hide real flush failures and suggests that cached completion
is scheduling a flush after its coordinator ownership has ended.

## Environment

- CallAgent commit: `2c661ee`
- Host: `/Users/maximantonov/Work/_lab/itupdated`
- Runtime: SQL-backed in-process streaming runner, not Hatchet
- Date reproduced: 2026-07-20

## Reproduction

From the host checkout, ensure fixture selectors exist and run either scenario:

```bash
yarn run:testscenario FIX-S33 --skip-discovery
yarn run:testscenario FIX-S37 --skip-discovery
```

Both scenarios fetch a detail page and then run `get-detail`. The nested
`fetch-html` operation reports a cache hit immediately before the warning.

Observed output:

```text
fetch-html (cached result)
FlushScheduler: Flush failed for key default:a2a_..._fetch-html_...:
Task turn coordinator for a2a_..._fetch-html_... is invalid: state is missing
```

The same run then publishes a completed result with `ok: true`, and the host
scenario passes its required-field assertions.

## Expected Behavior

One of the following should happen:

1. Cached completion participates in a valid coordinator lifecycle and its flush
   succeeds; or
2. no flush is scheduled when the cached result has already been durably admitted
   and the coordinator is no longer required.

A normal cache hit must not emit an error-level flush failure. If the missing
coordinator is intentionally benign, the scheduler should classify that condition
explicitly rather than handling it as an arbitrary flush error.

## Acceptance Criteria

- Repeated cached nested-tool calls complete without the missing-state error.
- Uncached tool completion behavior remains unchanged.
- A genuinely missing coordinator during active ownership still fails loudly.
- Add a regression test covering a cached blocking child/tool result whose parent
  reaches an authoritative completed terminal.
- SQL-backed in-process and Hatchet behavior remain aligned where applicable.

## Host Impact

No result corruption or runner hang was observed. The complete host matrix passed
all other scenario assertions after selector setup. This report is non-blocking
for the current SiteConfig work.
