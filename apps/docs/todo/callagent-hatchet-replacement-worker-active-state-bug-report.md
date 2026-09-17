# Recovered Hatchet task failed after replacement worker became inactive

**Status:** Open pending packaged Hatchet/PostgreSQL restart regression  
**Severity:** Critical  
**Observed:** 2026-09-05

The production task recovered its original generation, logical turn, checkpoint,
and higher fence after a restart, but a later `Hatchet worker is not ACTIVE` signal
was wrapped as a module failure and converged as `HATCHET_PROVIDER_FAILED`.

The implementation now uses typed worker-lifetime control flow, exact process
identity, immediate coordinator recovery, stale-provider suppression, replacement
root reconstruction, and the original root deadline as the sole recovery bound.
Mark this report Resolved only after the packaged restart-twice regression passes.
