# Orchestrator Substrate Harness

This is a temporary design and validation workspace for adopting a durable
orchestrator (Hatchet) **underneath** the APLRET runtime. It exists to define the
driver seam, the durable-execution mapping, ADRs, deletion targets, and POC
scenarios before any production runtime change is made.

It mirrors the structure of the (now promoted) streaming harness at
`apps/docs/todo/done/next-phase-better-readability/streaming-harness/`.

Delete this folder only after:

- Accepted ADRs are moved or referenced from permanent architecture docs.
- Accepted specs are promoted into permanent docs and/or code.
- POC scenarios are converted into permanent automated tests.
- The deletion inventory has been executed (per surface) and verified.
- Any disposable scripts/adapters are removed or promoted.

## Core thesis

callAgent already implements durable cognition (the APLRET loop + `MentalState`
snapshots + CAS). It lacks a production infrastructure layer for durable timers,
crash recovery, worker pools, fairness, an ops UI, and log/metrics collection.

Hatchet's durable-execution model — *durable tasks only **wait** (sleep/event) or
**spawn children**, and push side effects into child tasks* — maps almost exactly
onto the APLRET await loop. This workspace designs that mapping while keeping the
APLRET cognition kernel untouched.

The chosen shape: **one shared kernel, two drivers behind a kernel seam.**

```text
           ┌─────────────────────────────────────────────┐
           │  Shared kernel (UNCHANGED)                    │
           │  oneTurn / runLoop / modules / MentalState    │
           │  snapshots (CAS) / canonical stream events    │
           └───────────────▲─────────────────▲────────────┘
                           │ TurnExecutor port │
        ┌──────────────────┴──┐         ┌──────┴───────────────────┐
        │ InProcessRuntimeDriver│        │ HatchetRuntimeDriver      │
        │ (default; "without")  │        │ (opt-in; "with"; native)  │
        │ today's TaskEngine    │        │ durable task = APLRET loop │
        └───────────────────────┘        │ waits = durable event/sleep│
                                         │ children = child spawning  │
                                         └────────────────────────────┘
```

The unit both drivers schedule is a **segment**: one `runLoop` execution advanced
to the next durable boundary (await / sleep / terminal). Internal `continue`
turns run in-process and never cross the driver boundary (ADR 0002).

## Scope

This workspace covers:

- The driver/kernel seam (`TurnExecutor` + `RuntimeDriver`).
- The Hatchet durable-execution mapping for start, resume, timers, and children.
- External wakes (`tasks/input`, tool/webhook callbacks, A2A child completion)
  as Hatchet events.
- Snapshot ownership and idempotency under at-least-once delivery.
- Observability mapping (`driver_runs`, deep links to `TurnTrace`).
- The line-referenced deletion inventory and reversibility rules.
- POC scenarios and pass/fail gates.

This workspace does **not** implement production orchestrator behavior directly.

## Normative inputs

The design here must comply with:

- `apps/docs/drafts/orchestrator-substrate-requirements.md` (requirements,
  research outcomes, POC gates — the parent doc for this workspace).
- `apps/docs/0-aplret_contracts.md` (APLRET contracts).
- `apps/docs/17-runtime_streaming_contract.md` (canonical streaming contract).
- `apps/docs/todo/types-rules.md` (Zod-first, no public `any`, closed unions).
- `apps/docs/11-how_to_test_aplret_agents.md` and
  `apps/docs/12-how_to_debug_with_turn_trace.md` (testing/TurnTrace).

In particular:

- The APLRET loop, modules, and `MentalState` snapshot shape are **not**
  refactored.
- A segment is an opaque, non-deterministic unit; it never runs as Hatchet
  durable workflow code (only as a child/regular task). Internal `continue` turns
  stay in-process.
- The canonical streaming contract is unchanged; Hatchet mode requires a
  cross-process bus and does not use Hatchet's native stream (ADR 0007).
- `MentalState` lives only in callAgent snapshots; orchestrator payloads carry
  IDs and small event data.
- The in-process driver remains the default; the orchestrator is opt-in and
  reversible per surface.

## Hatchet docs reference

Vendored Hatchet docs live at `apps/docs/external/hatchet-docs/` (`@hatchet-docs`
in Cursor). **Before any Hatchet implementation work (Phases 1–5), read the
relevant pages here** — ADRs record our decisions, but SDK/API semantics and
guarantees must be verified against these docs.

Key pages:

- `pages/v1/durable-execution.mdx`, `durable-tasks.mdx`
- `pages/v1/durable-sleep.mdx`, `durable-event-waits.mdx`
- `pages/v1/child-spawning.mdx`, `concurrency.mdx`, `rate-limits.mdx`
- `pages/v1/scheduled-runs.mdx` (note the missed-schedule caveat; see ADR 0003)
- `pages/v1/architecture-and-guarantees.mdx`
- `pages/self-hosting/*`

## Contents

- `principles.md` — design principles and non-negotiables.
- `implementation-status.md` — where we are right now.
- `implementation-plan.md` — staged implementation plan.
- `migration-checklist.md` — promotion/deletion checklist.
- `adr/` — decision records to review before implementation (0001–0010).
- `specs/` — driver seam, kernel, Hatchet task model, worker runtime, deletion
  inventory.
- `harness/` — POC scenarios and expected outcomes.

Start with `adr/0001-kernel-seam-and-two-drivers.md` when reviewing this
workspace; it carries the central decision everything else depends on.
