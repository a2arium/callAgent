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
- [3.2 Manifest Split and Validation](./3.2-manifest-split-and-validation.md)
- [3.3 Invariant Error Shapes & Enforcement](./3.3-invariant-error-shapes.md)
- [3.4 Stage Facade Support](./3.4-stage-facade.md)
- [3.5 Manifest Provenance Tracking in TurnTrace](./3.5-turn-trace-provenance.md)
- [3.6 Canonical LLM Output Contracts (Enforced)](./3.6-llm-output-contracts.md)
- [3.7 Testing Harness](./3.7-test-harness.md)

## 4. Readability, repo ergonomics, and documentation corpus

Normative standards and author guides live in [APLRET contracts](../0-aplret_contracts.md), [How-to: `flow.md`](../13-flow_md_for_aplret_agents.md), and [How-to: Agent repository layout](../14-agent_repository_layout_for_aplret.md). Migrations: [4.1 flow.md adoption](../migration/4.1-flow-md-adoption-migration.md), [4.2 repo layout](../migration/4.2-agent-repo-layout-migration.md).

- [4.0 Readability phase overview](./4.0-readability-phase-overview.md)
- [4.1 `flow.md` standard (templates & tooling)](./4.1-flow-md-standard.md)
- [4.2 Agent repository layout & patterns (examples & scaffolds)](./4.2-agent-repository-layout-and-patterns.md)
- [4.3 Framework readability helpers & reference examples](./4.3-framework-readability-helpers-and-examples.md)
