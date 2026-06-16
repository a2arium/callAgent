# ADR 0003: Timers Use Durable Sleep

## Status

Proposed

## Context

The requirements research found a Hatchet scheduled-run caveat: missed scheduled
runs are not automatically caught up after service downtime. That makes
scheduled runs a poor sole source of truth for callAgent token expiry or
sleep-until semantics.

Hatchet durable sleep is a different primitive. The docs state that durable
sleep respects the original duration across interruptions of the durable task
and worker crashes, and consumes no worker resources while sleeping.

## Decision

Model callAgent runtime timers as Hatchet **durable sleep** inside the
per-task durable control loop, not as standalone scheduled runs.

Also add a callAgent `TimerReconciler` as defense in depth:

```text
on startup and every N minutes:
  scan pending tokens / sleep records where dueAt <= now and not fired
  enqueue or push aplret.timer.fire using deterministic idempotency key
```

Source of truth for timer semantics remains callAgent persisted state. Hatchet
provides waiting and dispatch.

## Consequences

- We use the Hatchet-native primitive that matches runtime sleeps.
- The scheduled-run missed-catch-up caveat does not become a production data-loss
  mode.
- Timer correctness still depends on callAgent idempotency, because duplicate
  timer fire is possible.

## Open Validation

POC B2 must test:

- worker restart before `dueAt`;
- Hatchet engine restart before `dueAt`;
- full Hatchet downtime during `dueAt`;
- duplicate timer fire.

The transition cannot delete old timer handling until B2 and the reconciler pass.
