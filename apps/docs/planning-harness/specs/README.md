# Specs

Each spec names the Zod home, the APLRET owner (Learning / Policy /
Execution / …), acceptance tests, and non-goals. Phases 1–6 are
**implemented** on `planning-harness`. Specs remain the contracts and
must stay consistent with `../principles.md`.

| File | Phase | Status |
|---|---|---|
| `plan-schema.md` | 1 | implemented (ADR 0001) |
| `plan-graph-helpers.md` | 2 | implemented (ADR 0002) |
| `plan-output-refs.md` | 3a | implemented (ADR 0003) |
| `plan-validation-and-lineage.md` | 3b | implemented (ADR 0004) |
| `execute-step-intent.md` | 4 | implemented (ADR 0005) |
| `turn-trace-extensions.md` | 5a | implemented (ADR 0006) |
| `memory-read-vs-observation.md` | 5b | implemented (ADR 0007) |
| `plan-patch.md` | 6a | implemented (ADR 0008) |
| `harness-snapshot-fork.md` | 6b | implemented (ADR 0009) |

`MentalState.extensions` (originating request §8) is **rejected** — see
ADR 0001 / 0004. There is no spec for it.
