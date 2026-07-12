# Migration: Manifest Intent Consent Enforcement

From the release containing this change, `hitl.requireConsentFor.intents` and `.tools` are active runtime obligations rather than inert metadata.

- Review existing manifests: every listed value must be trimmed, non-empty, unique, and declarable.
- Represent SiteConfig activation as `{ kind: 'internal', intent: 'activate_bundle', data: ... }` and list `activate_bundle`.
- Custom Shields still run first; `veto` and `defer` win, while transformed intents are matched after transformation.
- Approval input is the closed object `{ decision: 'approve' | 'reject' }` and expires after `hitl.consentTtlMs` (24 hours by default).
- Update every gated side-effect handler to deduplicate `ctx.effect.idempotencyKey`. This is required for logical once-only behavior across worker retries.
- Do not move receipts or manifest configuration into MentalState. Consent state is private durable control state.

After publishing, provide `itupdated` with the exact `@a2arium/callagent-types` and core package versions; activation must remain disabled until those versions are installed and its effect store deduplicates the key.
