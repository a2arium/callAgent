# APLRET Plan for Changes

This document outlines the breakdown of tasks required to fully align the `callagent` framework's runtime with the APLRET contracts. 

## Global Requirements for Every Task
1. **No Backwards Compatibility:** We explicitly do not support backwards compatibility. Legacy implementations must be aggressively replaced.
2. **Dedicated Migration Guides:** After **each** individual change is implemented, full step-by-step instructions for migration must be written and saved as a dedicated file in the `apps/docs/migration/` directory.
3. **Comprehensive Testing:** For every change:
   - Review all current tests that the change will affect.
   - Update existing tests if they are updatable.
   - Remove tests tied to deprecated behaviors and replace them with new ones enforcing APLRET rules.
   - Write entirely new unit and integration tests for any newly introduced functionality.

## 2. Implemented but Needs Reconfiguration (API Changed / Divergences)
- [2.1 ctx.vars / World Memory Bleed](./2.1-ctx-vars.md)
- [2.2 LLM Calls inside Policy](./2.2-llm-calls-inside-policy.md)
- [2.3 Learning Single-Writer Rule Violations](./2.3-learning-single-writer.md)
- [2.4 Intent vs ProposedAction Naming & Shape](./2.4-intent-vs-proposedaction.md)
- [2.5 Observation Source/Kind Taxonomy Tweaks](./2.5-observation-taxonomy.md)

## 3. New Things We Don't Have (Missing)
- [3.1 The Planning Model (M.plans)](./3.1-planning-model.md)
- [3.2 Invariant Error Shapes & Enforcement](./3.2-invariant-error-shapes.md)
- [3.3 Stage Facade Support](./3.3-stage-facade.md)
- [3.4 Manifest Provenance Tracking in TurnTrace](./3.4-turn-trace-provenance.md)
- [3.5 Canonical LLM Output Contracts (Enforced)](./3.5-llm-output-contracts.md)
- [3.6 Testing Harness](./3.6-test-harness.md)
