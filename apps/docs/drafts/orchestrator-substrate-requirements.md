# Durable Orchestrator Substrate — Requirements

> Status: design draft.
> This document defines requirements for an optional, pluggable durable
> orchestration substrate that sits **underneath** the APLRET runtime. It does
> not change APLRET contracts. Verify stable contracts in
> `apps/docs/0-aplret_contracts.md` and the streaming contract in
> `apps/docs/17-runtime_streaming_contract.md`.

## 1. Purpose and Scope

callAgent already implements durable cognition: the APLRET loop runs turns,
persists `MentalState` snapshots with optimistic concurrency (CAS), and
auto-resumes on `await_input` / `await_tool` / `await_child`. It also has a
transactional outbox, an event bus, durable subscriptions, and dead-letter
paths.

What it does **not** have is a production-grade infrastructure layer for:

- durable timers and delayed/scheduled wake-ups ("sleep N, then resume"),
- crash recovery of in-flight work and orphan detection,
- worker pools with concurrency, rate limiting, and per-tenant fairness,
- an operations UI, log/trace collection, and manual management (retry, cancel,
  replay, requeue from DLQ).

The goal is to introduce an **optional** substrate that provides those
capabilities while leaving the loop, snapshots, and agent-author surface
untouched.

### In scope

- A driver/port abstraction that lets the core schedule durable work.
- An orchestrator-backed adapter (one or more of Inngest / Trigger.dev /
  Hatchet / Temporal) implementing that port.
- A default in-process adapter preserving today's behavior.

### Out of scope (explicitly not refactored)

- The APLRET loop (`runLoop` / `oneTurn`) and its module contracts.
- `MentalState` snapshot shape and the snapshot store (`SessionManager`,
  `SnapshotRepository`, CAS via `wmVersion`).
- The canonical runtime streaming event model and its projections (SSE / chat
  bridge / CLI).
- The agent-author API (`createAgent`, `ctx.*`, observations, intents).

## 2. Architectural Principles (non-negotiable)

These are hard constraints. A candidate that forces violating them is
disqualified.

- **P1 — The loop is not replaced.** The orchestrator never executes cognition.
  It only schedules and delivers calls into existing engine entry points.
- **P2 — Single source of truth for cognition.** `MentalState` lives only in
  callAgent snapshots. The orchestrator must not become a second store of agent
  state. Its payloads carry identifiers and small event data, never full
  snapshots (mirrors the existing "artifact handle, not blob" rule).
- **P3 — Driven operations are idempotent steps.** Every unit the orchestrator
  drives (`startTask`, `resumeInput`, child dispatch, timer fire) must be safe to
  deliver at-least-once, keyed by existing identifiers (`taskId`, pending
  `token`, `traceId`). Re-delivery must not corrupt state. CAS + the existing
  idempotency store are the enforcement points.
- **P4 — Non-deterministic steps.** A turn performs LLM/tool effects and is not
  replay-deterministic. The substrate must treat a turn as an opaque,
  non-deterministic activity/step. Workflow-as-code engines (Temporal/Inngest
  step replay) may be used **only** in their durable-step/activity mode, never by
  re-executing turn logic for determinism.
- **P5 — Works with and without the orchestrator.** The core depends on a port
  interface, not on any orchestrator. A default in-process implementation must
  preserve current behavior so local dev, tests, and the existing CLI/host run
  unchanged with zero new infrastructure.
- **P6 — No orchestrator types leak upward.** Agent authors and the public
  package surface must not import or reference orchestrator types. Wiring happens
  only at the composition root (adapter injection).
- **P7 — Reversible adoption.** The substrate can be switched on per surface and
  switched off, falling back to the in-process driver, without code changes in
  agents.

## 3. The Driver Seam (with/without mechanism)

The "with and without" requirement is satisfied by a single port the core
depends on. Two cooperating halves:

- **Producer port (`RuntimeDriver`)** — the core calls this to schedule durable
  work instead of calling `setTimeout`, polling the outbox inline, or resuming
  children inline.
- **Consumer/worker** — orchestrator-specific code that, when a job fires, calls
  back into the unchanged engine methods idempotently.

Proposed shape (illustrative; final contract to be reviewed):

```ts
export type DriverIds = {
  tenantId: string;
  taskId: string;
  agentId?: string;
  traceId?: string;
  /** Stable dedupe key derived from token/taskId; enables at-least-once safety. */
  idempotencyKey: string;
};

export type ResumeEvent =
  | { kind: 'input'; token: string; value: unknown }
  | { kind: 'tool'; token: string; result: unknown }
  | { kind: 'child'; token: string; childTaskId: string; output: unknown }
  | { kind: 'external'; token: string; type: string; data: unknown };

export type RuntimeDriver = {
  /** Schedule a fresh task start. */
  enqueueStart(params: DriverIds & { input: unknown }): Promise<void>;

  /** Schedule a resume; idempotent by token. */
  enqueueResume(params: DriverIds & { token: string; event: ResumeEvent }): Promise<void>;

  /** Schedule child dispatch and wire its completion back to the parent token. */
  enqueueChildDispatch(
    params: DriverIds & { parentTaskId: string; childTaskId: string; childAgentId: string; input: unknown; token: string }
  ): Promise<void>;

  /** Durable timer: wake a task at a wall-clock time (token expiry, sleep, cron tick). */
  scheduleTimer(params: DriverIds & { token: string; fireAt: string; payload?: unknown }): Promise<{ timerId: string }>;
  cancelTimer(params: { timerId: string }): Promise<void>;

  /** Cooperative cancellation/termination propagation. */
  cancel(params: { tenantId: string; taskId: string; reason: string }): Promise<void>;
};
```

The worker side registers handlers that call the engine, e.g. on a `start` job →
`engine.startTask(...)`, on a `resume` job → `engine.resumeInput(...)`. The
engine code does not change; the adapter is the bridge.

- **R-SEAM-1** The default `InProcessRuntimeDriver` MUST reproduce current
  behavior (immediate/in-process execution, `setTimeout`-based waits, outbox
  polling) so the framework runs with no external dependency.
- **R-SEAM-2** Orchestrator adapters MUST implement the same port without adding
  any new responsibilities to the engine.
- **R-SEAM-3** Selection MUST be configuration at the composition root (which
  driver to inject), defaulting to in-process.

## 4. Functional Requirements

- **R-F1 Durable invocation** of `startTask`, `resumeInput` (input/tool/child/
  external), and child dispatch as discrete, retryable, idempotent jobs.
- **R-F2 Durable timers** — schedule a wake at a future wall-clock time;
  required for pending-token expiry (`expiresAt`), agent "sleep until", and
  recurring/cron triggers. Timers MUST survive process restarts.
- **R-F3 At-least-once delivery with idempotency** keyed by `idempotencyKey`
  (derived from token/taskId). Duplicate delivery MUST be a no-op at the effect
  boundary.
- **R-F4 Retries** with configurable backoff and max attempts, then **dead-letter**
  with inspectable payload and error. SHOULD integrate with or replace the
  existing outbox/DLQ rather than create a parallel, unreconciled one.
- **R-F5 Per-task serialization** — at most one in-flight turn per `taskId`
  (single-writer). CAS protects correctness today, but the substrate SHOULD
  serialize to avoid wasted contention/retries.
- **R-F6 Concurrency control** — configurable limits per tenant, per agent, and
  globally; per-tenant fairness so one tenant cannot starve others.
- **R-F7 Rate limiting / throttling** — e.g. cap LLM-bound steps to respect
  provider limits.
- **R-F8 Crash recovery** — work in flight when a worker dies is re-delivered or
  re-claimed (visibility timeout / heartbeat). Orphaned tasks MUST be detectable.
- **R-F9 Cancellation** — cancel/terminate a task and propagate to children;
  cancellation MUST cooperate with snapshot state (no torn writes).
- **R-F10 Fan-out / fan-in** — dispatch multiple children and resume the parent
  when results arrive (supports topics/panels). Ordering per parent token MUST
  be respected.
- **R-F11 Backpressure** — when overloaded, the substrate slows intake rather
  than dropping work or unbounded memory growth.

## 5. Observability and Management Requirements

These are the capabilities explicitly missing today (UI, logs, management).

- **R-O1 Operations UI (rich, first-class)** — a genuinely good, useful web UI
  is a primary requirement, not a nice-to-have. It MUST:
  - list/search/filter tasks and steps by `tenantId`, `agentId`, `taskId`,
    `traceId`, status, and time range;
  - show per-task status, full step timeline, attempts/retries, durations, and
    payloads/inputs/outputs;
  - drill into a single run: every step, its logs, errors, and the retry/DLQ
    history in one place;
  - surface queue depth, throughput, failure rate, and DLQ contents visually;
  - drive manual operations directly (retry, cancel, replay, requeue-from-DLQ,
    pause/resume) — see R-O5.
  The UI MUST be included and fully functional in the self-hosted deployment at
  no cost (see R-OP1).
- **R-O2 Log collection** — per-task/per-turn logs collected and correlated.
  MUST correlate via existing fields (`traceId`, `spanId`, `correlationId`,
  `taskId`) rather than inventing a parallel identity. (See
  `DurableHandlerInvoker` which already prefixes handler logs.)
- **R-O3 Trace integration** — step-level traces that link to, but do not
  duplicate, `TurnTrace` and the telemetry tree. TurnTrace remains authoritative
  for cognition; the substrate view is the infra/timing layer.
- **R-O4 Metrics** — throughput, latency, queue depth, retry counts, failure
  rate, DLQ size; exportable (OpenTelemetry/Prometheus preferred).
- **R-O5 Manual operations** — retry, cancel, replay, requeue-from-DLQ,
  pause/resume queues, from UI and/or API.
- **R-O6 Alerting** — on DLQ growth, stuck tasks, elevated failure rate.

## 6. Data and Identity Integration

- **R-D1 Identity mapping** — a stable mapping between callAgent identifiers
  (`tenantId`, `taskId`, `token`, `traceId`, `spanId`) and the orchestrator's
  run/step IDs, so UI and logs cross-reference cleanly.
- **R-D2 Small payloads** — job payloads carry IDs + minimal event data; large
  data stays in artifacts/snapshots (P2).
- **R-D3 Outbox reconciliation** — define whether the substrate replaces the
  `OutboxPublisher` poll loop, consumes the outbox, or coexists. There MUST NOT
  be two unreconciled delivery mechanisms for the same event.
- **R-D4 Multi-tenancy isolation** — tenant boundaries preserved in queues,
  metrics, and UI access.
- **R-D5 Idempotency keys** — derivable deterministically from existing tokens
  so retries dedupe without new bookkeeping.

## 7. Operational and Deployment Requirements

- **R-OP1 Self-hosted, fully free (disqualifier)** — must be runnable on
  infrastructure we control, and **all** required features — including the rich
  operations UI (R-O1), durable timers, retries/DLQ, concurrency/rate limiting,
  metrics, logs, and manual management (R-O5) — MUST be available in the
  self-hosted edition at no cost. Solutions that gate the UI, observability, or
  any of these capabilities behind a paid/cloud-only tier (open-core where the
  needed features live only in the paid plan) are disqualified. A managed/cloud
  option may exist as a convenience, but MUST NOT be required to get the full
  feature set. License MUST permit our self-hosted use without per-seat or
  per-feature fees.
- **R-OP2 Postgres affinity (strong preference)** — we already run Postgres via
  Prisma. A Postgres-backed substrate minimizes new infra. A separate datastore
  is acceptable only if justified by capability.
- **R-OP3 TypeScript-native** — first-class TS SDK, ESM, Node >= 20, no `any` in
  our adapter surface, `type` over `interface` per repo conventions.
- **R-OP4 Runtime flexibility** — works in long-running worker processes and
  (ideally) serverless; must support our streaming host model.
- **R-OP5 Local/test story** — the full test suite and local dev MUST run with
  the in-process driver and no external services. Adapter integration tests MAY
  require the service (e.g. via testcontainers, as already used for NATS).
- **R-OP6 No lock-in** — P5/P7 (with/without + reversible) are the escape hatch;
  the port keeps switching cost bounded.
- **R-OP7 Cost/licensing** — license compatible with our self-hosted use; the
  full required feature set (especially the UI and observability/management) MUST
  be free in self-hosted form, with no per-seat, per-feature, or usage-metered
  fees to unlock it. See R-OP1.

## 8. Non-Functional Requirements

- **R-N1 Interactive latency** — chat/SSE turns are latency-sensitive. Per-resume
  overhead today is ~20–135ms. The substrate MUST offer a low-latency path for
  hot/interactive tasks (a durable queue hop per token must not make chat feel
  sluggish), while long-running/awaiting tasks use the fully durable path. A
  hybrid (fast in-process resume for hot tasks + durable scheduling for
  timers/awaits) is acceptable and may be preferred.
- **R-N2 Ordering** — FIFO per `taskId`; resume events for one task apply in
  order.
- **R-N3 Effect exactly-once is not assumed** — infra guarantees at-least-once;
  exactly-once *effects* rely on idempotency at the effect boundary (existing
  `IdempotencyStore`). This MUST be documented and tested.
- **R-N4 Failure isolation** — a poisoned task or tenant cannot take down the
  worker pool.
- **R-N5 Observability overhead** — log/metric collection must not materially
  degrade turn latency.

## 9. Migration / Adoption Requirements

- **R-M1 Incremental** — first adopt the substrate for the lowest-risk, highest-
  value surfaces: durable timers (token expiry / sleep) and outbox dispatch.
  Then resume delivery, then child dispatch.
- **R-M2 Reversible** — each surface can fall back to in-process via config.
- **R-M3 Non-breaking** — existing tests pass unchanged with the default driver;
  no agent code changes required.
- **R-M4 Deletion target** — success includes removing hand-rolled
  `setTimeout`/CAS-retry/child-resume-race logic in `taskEngine.ts` once a
  surface is fully on the substrate.

## 10. Candidate Evaluation Rubric

Score each candidate (Temporal, Hatchet, Inngest, Trigger.dev) 0–3 against the
weighted criteria. "Disqualifier" rows are pass/fail.

| Criterion | Source reqs | Weight | Disqualifier? |
|---|---|---|---|
| Pluggable behind our port; no upward leakage | P5, P6, R-SEAM-* | High | Yes (must be pluggable) |
| Non-deterministic step model (turn as activity) | P4 | High | Yes |
| Durable timers / scheduled wake / cron | R-F2 | High | — |
| Crash recovery + orphan detection | R-F8 | High | — |
| At-least-once + idempotency keys | R-F3, R-D5 | High | — |
| Retries + DLQ + requeue | R-F4, R-O5 | High | — |
| Per-task serialization + concurrency/rate limits | R-F5–R-F7 | Med | — |
| Rich, useful ops UI (search by our IDs) | R-O1, R-D1 | High | Yes (must have a strong UI) |
| Self-hosted with ALL features free (no paid-tier gating) | R-OP1, R-OP7 | High | Yes |
| Log/trace/metrics integration (OTel) | R-O2–R-O4 | Med | — |
| Postgres-backed (reuse infra) | R-OP2 | Med | — |
| TypeScript-native DX | R-OP3 | Med | — |
| Interactive low-latency path | R-N1 | High | — |
| Local/test without the service | R-OP5 | High | Yes |
| Lock-in / portability | R-OP6 | Med | — |

### Quick prior read (to be validated during deep-dive)

- **Hatchet** — Postgres-backed, self-hostable, concurrency/rate limits, TS SDK;
  strongest infra fit given our stack.
- **Inngest** — event-native + durable steps + sleeps + cron, best DX; event
  model maps onto our observation/inbox model; check self-host + interactive
  latency.
- **Temporal** — most powerful + true durable timers, but heaviest ops and step
  model must be constrained to activities (P4); reserve for proven scale need.
- **Trigger.dev** — strong TS background-jobs DX, self-hostable (v3); validate
  fit as agent-resume substrate vs. plain background jobs.

## 11. Open Questions

- Does the substrate **replace** the `OutboxPublisher` and in-process durable
  subscription, or wrap them? (R-D3)
- For interactive chat, do we keep hot resumes fully in-process and only push
  timers/awaits/children to the substrate? (R-N1)
- One global worker vs. per-tenant workers for isolation/fairness? (R-F6, R-N4)
- How do we reconcile the substrate's run history UI with `TurnTrace` and the
  telemetry tree without duplicating storage? (R-O3)
- Cancellation semantics mid-turn: cooperative checkpoints vs. await-boundary
  only? (R-F9)
```
