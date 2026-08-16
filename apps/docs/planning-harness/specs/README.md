# Specs

Write these before the matching implementation phase. Each spec should name
the Zod home, the APLRET owner (Learning / Policy / Execution / …), acceptance
tests, and non-goals.

| File | Phase | Status |
|---|---|---|
| `plan-schema.md` | 1 | written — ready for implementation |
| `plan-graph-helpers.md` | 2 | written — ready for implementation after Phase 1 |
| `plan-output-refs.md` | 3a | written — ready after Phase 1 (ADR 0003) |
| `plan-validation-and-lineage.md` | 3b | written — ready after Phase 1–2 (ADR 0004) |
| `execute-step-intent.md` | 4 | written — ready after Phase 1–2 (ADR 0005) |
| `turn-trace-extensions.md` | 5a | written — ready (ADR 0006) |
| `memory-read-vs-observation.md` | 5b | written — ready (ADR 0007) |
| `plan-patch.md` | 6a | written — ready after Phase 1–2 (ADR 0008) |
| `harness-snapshot-fork.md` | 6b | written — ready (ADR 0009) |

Each spec is the implementation contract for its ADR and must stay
consistent with `../principles.md`. Do not implement a phase until its
prerequisites in that spec have landed.

`MentalState.extensions` (originating request §8) is **rejected** — see
ADR 0001 / 0004. There is no spec for it.
