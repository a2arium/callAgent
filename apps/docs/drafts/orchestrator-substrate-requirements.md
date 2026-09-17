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

Resolved answers live in [§13 Research outcomes](#13-research-outcomes). Remaining open items:

- **C2** — total infra cost at expected volume (deferred until production sizing).
- **C3** — HA / RPO-RTO for orchestrator state vs snapshot DB (deferred until production scope).
- **B10** — upgrade drill with active timers/runs (production gate; optional in POC unless timers migrate).
- **B11** — 100k-run volume / retention storage test (after functional POC gates pass).

Former §11 items now decided in §13: outbox reconciliation (A2), hybrid latency (A1), worker topology (A5), TurnTrace/UI split (A4), cancellation v1 semantics (A6).

## 12. Additional Research Questions

Use these before and during the Hatchet-first POC. Each question should have a
written answer (even "deferred") before committing to a vendor.

### A. Pre-POC design decisions (answer before writing adapter code)

| # | Question | Why it matters | How to answer |
|---|----------|----------------|---------------|
| A1 | **Hybrid latency model**: which `RuntimeDriver` operations stay in-process vs go through the substrate in production? | R-N1 — a queue hop on every chat resume may break SSE/chat UX. | Decide default config: e.g. in-process `enqueueResume` for interactive paths; substrate for `scheduleTimer`, outbox dispatch, child dispatch. Document per-surface overrides. |
| A2 | **Outbox reconciliation**: does the substrate replace `OutboxPublisher`, consume the outbox table, or coexist during migration? | R-D3 — two delivery paths for the same event type is forbidden. | Write a one-page migration sequence: Phase 1 substrate dispatches outbox rows → retire poll loop when proven. Define the cutover flag. |
| A3 | **Conversation vs task scope**: does the substrate own conversation/message-log delivery, or only task turn scheduling (`startTask` / `resumeInput` / timers / children)? | Avoid scope creep; NATS/eventbus already exists for conversation. | Explicit boundary doc: substrate = task driver; `IEventBus` / `MessageLog` / NATS = conversation transport unless a later phase says otherwise. |
| A4 | **Ops UI expectations**: is the orchestrator dashboard alone sufficient for R-O1, or do we need a callAgent ops layer (deep links run → task → `TurnTrace`)? | R-O1, R-O3 — no vendor shows APLRET cognition natively. | Decided: Hatchet is the infrastructure/debug view; callAgent owns the semantic `AgentRunGraph` product view. Mock the operator workflow against `GET /tasks/:taskId/run-graph`. |
| A5 | **Worker topology**: one global worker pool vs per-tenant workers vs co-located with the API host? | R-F6, R-N4, R-OP4 — affects fairness, blast radius, and streaming host layout. | Match to deployment model (`runtime-host`, future multi-tenant SaaS). Start with one pool + concurrency keys; note when to split. |
| A6 | **Cancellation semantics**: cancel only at await boundaries, or attempt mid-turn cooperative cancel? | R-F9 — mid-turn cancel needs checkpoints in Execution/loop. | Prefer await-boundary cancel for v1 unless a concrete product need exists. Document interaction with snapshot + pending tokens. |

### B. Hatchet POC validation (answer during spike; gates vendor decision)

| # | Question | Why it matters | How to answer |
|---|----------|----------------|---------------|
| B1 | Does a **worker crash mid-turn** result in safe redelivery without corrupting snapshot state? | R-F8, P3 | Kill worker during `aplret.resume`; verify CAS/idempotency; confirm at-most-one effective turn. |
| B2 | Does a **durable timer** (`scheduleTimer` / `sleepUntil`) survive control-plane and worker restarts? | R-F2 | Schedule timer 5+ min out; restart Hatchet engine and workers; verify fire + idempotent handler. |
| B3 | Is **duplicate resume** (same `idempotencyKey` / token) a no-op at the effect boundary? | R-F3, R-D5 | Send duplicate `aplret.resume` jobs; assert one observation applied, one turn advanced. |
| B4 | Does **per-task serialization** work via concurrency key (`tenantId:taskId`, limit 1)? | R-F5 | Concurrent resumes for same task; measure CAS retry rate vs serialized execution. |
| B5 | Can the **dashboard search/filter** by `tenantId`, `agentId`, `taskId`, `traceId`, `token` via `additionalMetadata`? | R-O1, R-D1 | Attach metadata on every run; search in UI under realistic volume (100+ runs). |
| B6 | Does the UI support **retry, cancel, replay**, and failed-run inspection with attempt history? | R-O5 | Fail a job deliberately; perform each manual op from UI; note gaps vs R-O5 wording ("DLQ" vs "failed runs"). |
| B7 | Is the **self-hosted dashboard fully functional** without Hatchet Cloud (no cloud-only features needed)? | R-OP1 disqualifier | Deploy via self-host docs only; checklist every R-O1/R-O5 feature. |
| B8 | What is **p95 latency overhead** for substrate-scheduled resume vs in-process resume? | R-N1 | Benchmark both paths on the POC scenario; set acceptable threshold (e.g. <50ms added for hot path). |
| B9 | How does Hatchet handle **child fan-out × N** and parent resume when children complete out of order or one fails? | R-F10 | Run 5-child scenario from POC plan; verify parent token wiring and partial failure. |
| B10 | What is the **upgrade path** for the self-hosted control plane without losing scheduled timers or in-flight runs? | R-OP1 ops | Upgrade Hatchet version in staging; document rollback procedure. |
| B11 | What is **log/run retention** default, and can it meet our ops needs? | R-O2, R-O6 | Read retention config; test log export / OTel if needed. |
| B12 | What is the **minimal production infra** (Postgres only vs Postgres + RabbitMQ)? | R-OP2 | Deploy "simple" and "production" self-host profiles; note extra deps and when each is required. |

### C. Operational and organizational (answer before production commitment)

| # | Question | Why it matters | How to answer |
|---|----------|----------------|---------------|
| C1 | Who **owns on-call** for the substrate control plane (Hatchet engine, DB, optional RabbitMQ)? | R-OP1 — self-host is free in license, not in ops cost. | Assign team/role; estimate upgrade cadence and incident runbooks. |
| C2 | What is **total infra cost** (compute, Postgres, RabbitMQ, monitoring) at expected task volume? | R-OP7 | Size for N tasks/day, M concurrent agents; compare to Hatchet Cloud pricing as sanity check. |
| C3 | Do we have **HA requirements** (multi-AZ, backup/restore for orchestrator state)? | Production readiness | Define RPO/RTO for orchestrator DB vs callAgent snapshot DB (may differ). |
| C4 | How do **alerts** fire on DLQ growth, stuck tasks, elevated failure rate? | R-O6 | Wire Prometheus/OTel from Hatchet; define alert rules; test one synthetic failure. |

### D. Integration with callAgent (answer during POC implementation)

| # | Question | Why it matters | How to answer |
|---|----------|----------------|---------------|
| D1 | Where is `RuntimeDriver` **injected** at the composition root without leaking types upward? | P5, P6, R-SEAM-* | Prototype injection in `runtime-host` / `TaskEngine` constructor; verify agents unchanged. |
| D2 | Which **`taskEngine.ts` surfaces** move to the driver first (timers, outbox, resume, child)? | R-M1 | Map call sites (`setTimeout`, `OutboxPublisher`, child-resume loops) to driver methods; estimate deletion target (R-M4). |
| D3 | How do substrate run IDs map to **`traceId` / `taskId`** for cross-UI navigation? | R-D1, R-O3 | Store mapping in run metadata + optional small `driver_runs` table if needed. |
| D4 | Does existing **`IdempotencyStore`** cover all substrate-delivered operations, or do we need new keys? | R-F3 | Audit `tasks/input`, tool resume, child complete paths; define key derivation (`token`, `taskId:operation`). |
| D5 | Do **`InProcessRuntimeDriver` tests** pass unchanged when driver is default? | R-M3, R-OP5 | Run full test suite with in-process driver; add adapter tests behind feature flag. |

### E. Fallback paths (answer only if Hatchet POC fails relevant gates)

| # | Question | Why it matters | How to answer |
|---|----------|----------------|---------------|
| E1 | If Hatchet fails **maturity/crash recovery** (B1, B10), does **Temporal Activity-only** pass the same POC scenario? | Fallback baseline | Build minimal Temporal adapter for same gates; compare ops burden (C1–C3). |
| E2 | If Hatchet fails **ops/UI** but passes durability, is **pg-boss / graphile-worker** on existing Postgres enough for Phase 1 (timers + outbox only)? | R-OP2 middle path | 2-day spike: durable dispatch + timer; accept thinner UI; revisit Hatchet/Temporal later. |
| E3 | If considering **Inngest**, does **SSPL** permit our use case (self-hosted substrate embedded in or distributed with callAgent)? | R-OP1, R-OP7 | Legal review of server license + Section 13 service obligations before any POC. |
| E4 | Is **Trigger.dev** ever viable for substrate if self-hosted **checkpoints** ship later? | Re-evaluate only if requirements soften | Revisit only if v4+ self-host gains checkpoint parity; until then remain rejected for R-F2. |

### F. Decision checklist (all must be green before vendor commitment)

- [x] A1–A6 answered in writing — see [§13](#13-research-outcomes)
- [ ] B1–B12 executed in Hatchet POC (or explicitly waived with rationale)
- [ ] C1–C4 acceptable for production timeline (C1/C4 answered; C2/C3 deferred)
- [ ] D1–D5 demonstrated in `runtime-host` or equivalent
- [x] E* fallback paths documented — see [§13](#13-research-outcomes)
- [x] No second unreconciled delivery path for outbox (A2 design decided)
- [x] Hybrid latency model documented (A1); [ ] benchmarked (B8)
- [x] `InProcessRuntimeDriver` remains default; substrate opt-in per deployment (design decided; D5 to prove in POC)

## 13. Research outcomes

> Status: research complete for pre-POC design; Hatchet POC not yet executed.
> Vendor commitment: **not yet** — proceed to Hatchet-first POC with gates below.

### Executive conclusion

**Hatchet remains the best first POC candidate.** Do not commit to Hatchet as the
production substrate until POC gates pass. **Temporal** is the durability/ops
maturity fallback. **Inngest** requires legal review before any POC (SSPL).
**Trigger.dev** is rejected for this substrate (self-hosted checkpoint gap).

Primary risk discovered during research: Hatchet **does not automatically run
missed scheduled tasks** after control-plane downtime. Therefore
`scheduleTimer` must never be Hatchet-only; callAgent must own timer
reconciliation (see [Timer reconciliation](#timer-reconciliation)).

```text
POC Hatchet first, scoped to:
  1. outbox dispatch
  2. async resume delivery
  3. child dispatch (after 1–2)
  4. timers only after B2 passes OR TimerReconciler is proven

Keep interactive chat/SSE resumes in-process by default.
```

### Pre-POC design decisions (A1–A6)

#### A1 — Hybrid latency model

| `RuntimeDriver` operation | Default production path | Reason |
|---|---|---|
| `enqueueStart` | Hatchet | New task start can tolerate a queue hop. |
| `enqueueResume` (active chat/SSE) | In-process | Avoid queue latency on interactive UX (R-N1). |
| `enqueueResume` (tool/webhook/external) | Hatchet | Retry, crash recovery, operator visibility. |
| `scheduleTimer` | Hatchet + `TimerReconciler` | Only after B2/reconciler proven; never Hatchet-only. |
| `enqueueChildDispatch` | Hatchet (Phase 3+) | Fan-out/fan-in; correctness-sensitive. |
| Outbox dispatch | Hatchet (Phase 1) | Highest value, lowest cognition risk. |
| `cancel` | Hybrid | Mark snapshot first; cancel Hatchet runs where applicable. |

Hatchet is not a sub-millisecond dispatch system; do not require the async
resume path to satisfy active chat latency.

#### A2 — Outbox reconciliation

Hatchet **consumes the existing outbox table**; it does not create a parallel
delivery path.

```text
Phase 0: OutboxPublisher remains authoritative.
Phase 1: HatchetOutboxDispatcher behind feature flag.
Phase 2: Hatchet claims outbox rows by type/surface.
Phase 3: Exactly one delivery path active per event type.
Phase 4: Compare delivery counts, retries, failures, duplicates.
Phase 5: Disable old poll loop for proven event types.
Phase 6: Delete old code after production soak.
```

Invariant: **for a given outbox event type, exactly one delivery mechanism is
authoritative.**

#### A3 — Conversation vs task scope

Substrate owns **task scheduling only**:

```text
In scope:  startTask, resumeInput, tool/child/timer resume, child dispatch, outbox dispatch
Out of scope: MessageLog, conversation transport, NATS/IEventBus, SSE/chat bridge, TurnTrace storage
```

#### A4 — Ops UI expectations

Hatchet dashboard alone is **not sufficient** for full R-O1/R-O3. Use the
callAgent `AgentRunGraph` as the primary operator view and Hatchet UI as the
linked infrastructure/debug layer.

Hatchet does not understand `MentalState`, pending tokens, `TurnTrace`, APLRET
turn boundaries, child-agent semantics, or `wmVersion`. Minimum addition:
semantic graph projection/persistence (`AgentRun`, `AgentRunEdge`, `TurnRun`,
`EffectRun`, grouped events/logs), plus `driver_runs` as the provider id/deep
link table (see [D3 mapping](#d3--run-id-mapping)).

**Metadata caveat:** Hatchet run filtering with multiple `additional_metadata`
pairs uses logical **OR**; event filtering uses **AND**. Use composite keys for
reliable operator lookup: `tenantTaskKey`, `tenantTraceKey`, `taskTokenKey`.

#### A5 — Worker topology

Start with **one global worker pool per environment**; split by tenant/workload
only when metrics prove it needed.

```text
runtime-host API
  └─ InProcessRuntimeDriver (hot chat/SSE path)

hatchet-worker pool
  ├─ aplret.start
  ├─ aplret.resume.async
  ├─ aplret.timer.fire
  ├─ aplret.child.dispatch
  └─ aplret.outbox.dispatch
```

Fairness controls:

```text
per-task serialization: tenantId:taskId, limit 1
tenant fairness: tenantId (Group Round Robin)
rate limits: agentId or llmProvider key
```

#### A6 — Cancellation semantics (v1)

**Await-boundary / task-boundary cancellation only** — not mid-turn preemption.

```text
cancel(taskId):
  1. callAgent marks cancellation intent in snapshot/task state.
  2. pending tokens become non-resumable (idempotency + cancelled flag).
  3. queued Hatchet jobs cancelled where possible.
  4. running turn finishes current effect boundary.
  5. next await/resume boundary observes cancellation and stops.
```

Edge cases:

- If Hatchet job is already running when snapshot is marked cancelled → let
  current turn finish; block subsequent resumes.
- If Hatchet cancel API fails after snapshot update → reconciler scans for
  cancelled tasks with queued Hatchet runs.

Mid-turn cooperative cancel requires APLRET loop / Execution changes; defer beyond
v1.

### Hard rules (from research — non-negotiable in POC)

1. **One Hatchet task per `RuntimeDriver` operation** — not one Hatchet workflow
   per APLRET task.
2. **Use regular Hatchet tasks** for opaque `engine.*` calls — not Hatchet
   durable tasks (durable tasks require deterministic replay; APLRET turns are
   non-deterministic per P4).
3. **Idempotency enforced in callAgent** (`IdempotencyStore` + CAS) — not in
   Hatchet. Hatchet may show duplicate attempts; business effects must change once.
4. **Snapshots remain cognition source of truth** — Hatchet payloads carry IDs
   and small event data only (P2).
5. **No orchestrator types above the adapter package** (P6).

### Phased adoption order

| Phase | Surface | Notes |
|---|---|---|
| 1 | Outbox dispatch | Lowest cognition risk; highest ops value. |
| 2 | Async resume (tool/webhook/external) | B1/B3/B4/B8 gates. |
| 3 | Child dispatch / fan-in | Parent-token wiring stays in callAgent. |
| 4 | Timers + `TimerReconciler` | Only after B2 or reconciler proven; never Hatchet-only. |
| 5 | Hot chat/SSE resume | Keep in-process unless benchmarks prove safe (unlikely). |

Deletion target (`taskEngine.ts`): hand-rolled `setTimeout`, inline outbox
polling, child-resume race logic, CAS retry loops that exist only because
scheduling is not serialized — **only after** each surface is migrated and
reversible (R-M4).

### Timer reconciliation

Hatchet docs: missed scheduled tasks are **not** automatically run when the
service comes back online. `TimerReconciler` is a **required callAgent
component**, not an optional fallback.

```text
On startup and every N minutes:
  scan pending tokens where expiresAt <= now AND not yet fired
  enqueue aplret.timer.fire with idempotencyKey = taskId:token:timer
  engine treats duplicate fire as no-op (IdempotencyStore + CAS)
```

Source of truth: callAgent snapshots / pending tokens. Hatchet dispatches and
retries; callAgent owns timer registry and expiry semantics.

### Hatchet POC task model

Use Hatchet as a **task driver**, not the APLRET workflow brain:

```text
aplret.start           -> engine.startTask(...)
aplret.resume.async    -> engine.resumeInput(...)
aplret.timer.fire      -> engine.resumeInput(timer event)
aplret.child.dispatch  -> engine.startTask(child); child completion resumes parent via callAgent token
aplret.outbox.dispatch -> claim outbox row -> publish event -> mark delivered
```

Required metadata on every run:

```ts
{
  tenantId, agentId, taskId, traceId, spanId, token,
  idempotencyKey, operation,
  tenantTaskKey: `${tenantId}:${taskId}`,
  tenantTraceKey: `${tenantId}:${traceId}`,
  taskTokenKey: `${taskId}:${token}`,
}
```

### Package and injection boundaries (D1)

```text
packages/core              -> RuntimeDriver type, InProcessRuntimeDriver
packages/driver-hatchet    -> HatchetRuntimeDriver, worker handlers, task defs
apps/examples/runtime-host -> selects driver from config
```

```ts
const runtimeDriver =
  config.driver === 'hatchet'
    ? createHatchetRuntimeDriver(...)
    : createInProcessRuntimeDriver(...);

const taskEngine = new TaskEngine({ /* ... */, runtimeDriver });
```

No agent code imports Hatchet types.

#### D3 — Run ID mapping and semantic graph

`driver_runs` table (authoritative for exact provider joins; Hatchet metadata for search):

```sql
driver_runs(
  id, provider, provider_run_id, provider_task_run_id,
  tenant_id, agent_id, task_id, token, trace_id, span_id,
  idempotency_key, operation, status, created_at, updated_at
)
```

Hatchet run history is **ops convenience** (default retention ~30 days). Long-term
audit and product UX rely on the callAgent `AgentRunGraph`, `TurnTrace`,
snapshots, and callAgent telemetry — not Hatchet alone.

Durable graph persistence target:

```text
agent_runs       root task/agent status, input/output previews, trace ids, provider ids
agent_run_edges  parent/child task+agent ids, edgeToken, edgeKind, status/result/error
turn_runs        segment/turn details, boundary.kind, turnSeq, TurnTrace refs
effect_runs      outbox/tool/stream effects, hidden/debug classification
```

#### D4 — Idempotency keys

| Operation | Key |
|---|---|
| `startTask` | `taskId:start` |
| input resume | `token:input` or `token` if globally unique |
| tool resume | `token:tool` |
| child completion | `parentTaskId:token:childTaskId` |
| timer fire | `taskId:token:timerId` |
| outbox publish | `outboxRowId:eventType` |

#### D5 — Testing layout

```text
Default (CI/local):  InProcessRuntimeDriver only; no Hatchet/Docker
Adapter integration: HATCHET_ENABLED=true; Docker Compose (not Lite)
```

### Idempotency / DLQ semantics

- **DLQ-equivalent:** Hatchet failed terminal run + replay/cancel/filter — a
  literal queue named DLQ is not required (R-F4/R-O5).
- **Duplicate delivery:** Hatchet may retry; callAgent must no-op at effect
  boundary.

### Minimal production infra (B12)

| Mode | Use |
|---|---|
| Hatchet Lite | Local smoke only — not for POC gates |
| Docker Compose (Postgres + RabbitMQ) | **POC and production default** |
| Kubernetes + external Postgres | Production HA path |

Assume **Postgres + RabbitMQ + API/engine/dashboard + workers** for real
production unless benchmarks prove Postgres-only is sufficient.

### Operational decisions (C1, C4)

| Area | Owner |
|---|---|
| Hatchet API/engine/dashboard, Postgres/RabbitMQ backups | Platform/runtime infra |
| `RuntimeDriver` semantics, idempotency/CAS correctness | callAgent runtime owner |
| Operator runbooks | Shared |
| Incident triage | Platform first, runtime second |

Minimum alerts: `driver_failed_runs_total`, `hatchet_queue_depth`, retry/reassignment
rate, `outbox_oldest_unpublished_age_seconds`, `timer_lag_seconds`,
`resume_duplicate_noop_total`, `cas_conflict_total`, `orphan_pending_token_total`.

Hatchet Prometheus metrics available in self-hosted mode; wire alongside
callAgent driver metrics.

### Fallback paths (E1–E4)

| Candidate | Status |
|---|---|
| **Temporal** (Activity-only) | Fallback if Hatchet fails B1/B3/B7 or upgrade safety (B10). Heavier ops; workflow code must stay deterministic — only Activities call `engine.*`. |
| **pg-boss / Graphile Worker** | Phase 1 only (outbox + simple delayed jobs) if Hatchet fails ops/UI but passes durability. No rich R-O1 UI. |
| **Inngest** | Blocked until legal confirms SSPL acceptable for embedded/distributed substrate. |
| **Trigger.dev** | Rejected until self-hosted checkpoint parity is documented and production-supported. |

### POC environment

Use **Docker Compose production profile** from day one of the POC — not Hatchet
Lite — so B1/B7/B12 results are representative.

### POC pass/fail criteria

#### Must pass (POC blockers — vendor decision)

| Gate | Test |
|---|---|
| **B1** | Kill worker during `aplret.resume`; one effective state transition; duplicate redelivery no-op |
| **B3** | Two resume jobs, same `idempotencyKey`; one observation applied |
| **B5** | 100+ runs; operator finds failed agent run by `tenantTaskKey` / `traceId` or run graph in <30s |
| **B6** | Failed run shows payload, error, attempts, logs; replay/cancel from UI |
| **B7** | Self-hosted dashboard usable as debug infra without Cloud; semantic callAgent run graph answers product/operator questions |
| **D1** | No Hatchet types above adapter; injection at composition root |
| **D5** | Full test suite passes with `InProcessRuntimeDriver` default |

**B7 security sub-gates:** dashboard behind VPN/OAuth/reverse-proxy; scoped API
tokens; no Cloud account required for R-O1/R-O5.

#### Must pass or mitigated (timers)

| Gate | Test |
|---|---|
| **B2** | Timer survives worker/engine restart; downtime-during-`fireAt` handled by `TimerReconciler` |

If B2 fails **and** reconciler cannot close the gap → Hatchet limited to outbox +
async resume only.

#### Should pass (non-blockers for Phase 1)

| Gate | Test |
|---|---|
| **B4** | Per-task serialization; CAS retry rate near zero |
| **B8** | Async resume p95 overhead documented; hot path stays in-process |
| **B9** | 5-child fan-out; out-of-order completion; one child fails/retries |

#### Production gates (not POC blockers)

| Gate | When |
|---|---|
| **B10** | Upgrade drill with active timers/runs; ops runbook |
| **B11** | 100k synthetic runs; Postgres size, dashboard speed, retention |
| **C2** | Cost model at expected volume |
| **C3** | HA / RPO-RTO per state type |

#### Pivot rules

```text
B1 or B3 or B7 fail     -> Temporal Activity-only POC
B2 fails + no reconciler -> Hatchet for outbox + async resume only; no timer ownership
B5 or B6 fail           -> Re-evaluate Hatchet vs Temporal vs pg-boss (Phase 1)
```

### POC scenario (acceptance script)

```text
startTask
→ one turn produces await_tool token
→ schedule expiresAt timer (Phase 4)
→ resume with tool result before timer fires
→ duplicate resume arrives
→ child dispatch fan-out x5
→ one child fails/retries
→ worker dies mid-turn
→ parent resumes after all children
→ operator searches by taskId / traceId
→ operator cancels task
→ operator replays failed operation
```

### Decision state summary

| Item | Status |
|---|---|
| Pre-POC design (A1–A6) | Done |
| Vendor commitment | Not yet |
| POC authorization | Yes — Hatchet-first, scoped |
| Timer model | Hatchet dispatches + callAgent `TimerReconciler` |
| Default driver | `InProcessRuntimeDriver` |
| Next artifact | Implement port + in-process driver, then `packages/driver-hatchet` Phase 1 (outbox) |

### Recommended implementation order

1. `RuntimeDriver` port + `InProcessRuntimeDriver` in `packages/core`
2. Hatchet Docker Compose environment
3. POC Phase 1: `aplret.outbox.dispatch` + metadata + `driver_runs`
4. POC Phase 2: `aplret.resume.async` (B1/B3/B4/B8)
5. POC Phase 3: `aplret.child.dispatch` (B9)
6. POC Phase 4: `aplret.timer.fire` + `TimerReconciler` (B2)
7. Production gates: B10, B11, C2, C3
