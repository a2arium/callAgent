# Feature Request: Enforce Manifest Consent for Domain Intents

> **Status:** Implemented contract. SiteConfig activation must remain disabled until it consumes a released CallAgent version and deduplicates the supplied effect idempotency key.
>
> **Compatibility:** Opt-in. Agents without `hitl.requireConsentFor.intents` must execute exactly as they do today.

## Problem Statement

`AgentRuntimeManifest` accepts:

```json
{
  "hitl": {
    "level": "consent",
    "requireConsentFor": {
      "intents": ["activate_bundle"]
    }
  }
}
```

The current loop runtime does not enforce `requireConsentFor.intents` for domain intents. Built-in consent behavior exists only in the default Shield for generic `call_tool` actions, and supplying a custom Shield replaces that default. A manifest can therefore appear to require activation consent while Execution receives the activation intent without a consent pause.

This is a contract gap: a validated safety declaration must either be enforced or rejected as unsupported.

## Goals

1. Enforce manifest-declared consent for the repository's closed Intent union before Execution. SiteConfig activation uses `{ kind: 'internal', intent: 'activate_bundle', data: ... }`.
2. Keep the behavior fully opt-in and transparent to existing agents.
3. Compose with custom Shields instead of replacing or bypassing them.
4. Bind consent to one exact normalized intent and task.
5. Resume an approved intent at most once.
6. Ensure rejection, cancellation, stale consent, and mismatched consent never execute the intent.
7. Expose enough TurnTrace information to test and debug the gate without leaking sensitive intent data.

## Non-Goals

- Authenticating a human identity or defining an external approval API.
- Role-based authorization.
- Changing existing `call_tool` consent semantics except where needed to remove duplicate prompts.
- Adding consent automatically to manifests that do not request it.
- Letting agents interpret free-text “yes” without the runtime's pending-input token contract.

## Manifest Matching Contract

`hitl.requireConsentFor.intents` contains stable domain intent identifiers.

Intent identifier resolution must be deterministic:

1. Prefer the top-level domain `kind` when it is not a generic transport wrapper.
2. For the repository's legacy `{ kind: 'internal', intent: '<name>' }` shape, use the top-level `intent` string.
3. Never inspect arbitrary nested payload fields to infer an identifier.
4. If no stable identifier can be derived, fail manifest validation or startup when that undeclarable value is configured; do not guess at runtime.

Document the canonical identifier helper and use it for manifest matching, consent receipts, traces, and tests.

## Enforcement Order

Manifest consent is a runtime obligation that composes with the agent Shield:

```text
Policy proposes intent
        |
        v
Agent Shield
  veto   -> stop
  transform -> evaluate the transformed intent
  defer  -> honor agent defer
  pass   -> continue
        |
        v
Manifest consent obligation
  not listed/already approved -> Execution
  listed, no valid receipt    -> await_input
```

Rules:

- A custom Shield `veto` or `defer` result wins.
- The manifest gate runs only after Shield passes.
- The manifest gate cannot be disabled by providing a custom Shield.
- Execution must never receive a gated intent before a valid approval receipt is consumed.
- Existing agents with no configured intent list skip this branch entirely.

## Consent Receipt Contract

Define an internal durable receipt/pending record with at least:

```ts
type IntentConsentPending = {
    token: string;
    taskId: string;
    agentId: string;
    tenantId: string;
    intentId: string;
    intentDigest: string;
    requestedAt: string;
    expiresAt: string;
    effectIdempotencyKey: string;
    status: 'pending' | 'approved' | 'dispatching' | 'consumed' | 'rejected' | 'expired' | 'cancelled';
};
```

- `intentDigest` hashes the exact canonical intent. Redaction is used only for the human-facing summary; hashing redacted content could authorize a different secret-bearing payload.
- Gated intents must be canonical-JSON values; reject circular, non-plain, or otherwise non-JSON payloads rather than hashing a lossy representation.
- Do not store or emit raw secrets merely to build the receipt.
- The receipt lives in durable control/pending state, not MentalState cognition.
- Approval input must match the task, token, agent, tenant, intent identifier, and digest.
- Before Execution, durably reserve the receipt as `dispatching`. Retries reuse its deterministic effect idempotency key; the effect handler must deduplicate that key.
- Replaying an approval observation after consumption must not execute the intent again.
- A changed intent requires a new consent request even if its identifier is the same.

## Await and Resume Behavior

1. On the first gated turn, return the canonical `await_input` transition with a generated token and a sanitized approval summary.
2. The pending record must survive the normal durable task/session persistence path.
3. Resume only through a token-matched `input.provided` observation.
4. Normalize approval as a closed structured value such as `{ decision: 'approve' | 'reject' }`; transport adapters may render human-friendly controls but must produce this shape.
5. Approval makes an exact post-Shield re-proposal eligible for Execution. The runtime does not persist a raw intent solely to replay it.
6. Rejection returns a structured non-executing outcome that the agent can observe and handle.
7. Cancellation/expiry removes or terminally marks the pending receipt and never falls through to Execution.

The runtime persists `dispatching` before calling Execution and exposes the receipt-derived key as `ctx.effect.idempotencyKey`. Because snapshot commit and arbitrary external effects are not transactional, logical once-only activation requires the downstream effect to deduplicate this key, consistently with ADR 0009. Non-idempotent effects remain at-least-once across worker crashes.

## Interaction with Existing Tool Consent

- Avoid prompting twice when a `call_tool` action matches both existing level-based consent and a configured tool/intent rule.
- Define one precedence and one receipt path for all manifest consent gates.
- Preserve current behavior for manifests using only the existing `hitl.level` tool consent.
- `requireConsentFor.tools` should use the same durable receipt machinery where feasible, but broad tool-consent refactoring must not delay correct intent enforcement unless required for deduplication.

## TurnTrace and Public Output

TurnTrace should expose compact metadata:

```ts
{
  action: 'defer',
  reason: 'manifest_consent_required',
  intentId: 'activate_bundle',
  tokenPresent: true,
  receiptStatus: 'pending'
}
```

Do not emit raw intent payloads, secret values, full memory, or the unredacted digest source. Public streams may report that approval is required and the sanitized action summary, but private control records remain private.

## Error Semantics

| Condition | Required behavior |
|---|---|
| Listed intent, no receipt | Defer with `await_input`; no Execution |
| Valid approval | Execute exact intent once |
| Explicit rejection | Structured rejection; no Execution |
| Wrong token/task/tenant/agent | Ignore or reject as mismatch; no Execution |
| Same identifier, changed payload | Digest mismatch; request new consent |
| Replayed approval after consumption | Idempotent no-op; no second Execution |
| Stale/expired pending receipt | Structured expiry; no Execution |
| Custom Shield vetoes | Veto; do not request manifest consent |
| Custom Shield defers | Preserve agent defer; do not add a second defer |

## Implementation Touchpoints

- Runtime-manifest documentation and validation for canonical intent identifiers.
- Loop orchestration around Shield and Execution; enforcement must wrap custom Shields rather than live only in the default Shield implementation.
- Durable control/pending types and task snapshot persistence.
- Input-resume normalization for structured consent decisions.
- TurnTrace schemas/projections and test-harness helpers needed to assert defer, token, and one-shot resume behavior.

Use existing APLRET boundaries: Policy proposes; Shield checks agent policy; runtime obligations enforce the manifest; Execution performs effects; Transition carries await/terminal outcomes. Do not write consent decisions into Policy or use raw inbox parsing in Execution.

## Required Tests

### Compatibility

- No `requireConsentFor.intents`: existing golden traces remain byte-for-byte equivalent where stable trace fields permit.
- Existing custom Shields still receive the same intent and their block/defer/pass outcomes remain authoritative.
- Existing level-based tool consent does not produce duplicate prompts.

### Turn-script tests

- Listed domain intent defers before Execution and returns an await token.
- Unlisted domain intent executes normally.
- Custom Shield pass followed by manifest defer.
- Custom Shield block/defer prevents the manifest gate from adding another action.
- Token-matched approval executes once.
- Rejection never executes.
- Wrong token, task, agent, or tenant never executes.
- Changed payload with the same intent identifier requests consent again.
- Duplicate/replayed approval does not execute twice.
- Pending consent survives task/session persistence and resumes after restore.
- Cancellation and expiry are non-executing terminal paths.

### Trace and privacy tests

- TurnTrace records the consent branch, stable intent identifier, transition, and token presence.
- Public events omit raw intent payloads and private receipt state.
- Secret-bearing intent fields are redacted before summaries or digest diagnostics are emitted.

## Documentation and Migration

- Document `requireConsentFor.intents` as enforced only from the package version that ships this feature.
- Add a migration note for agents that declared intent consent previously: the declaration changes from inert metadata to active runtime behavior.
- Document canonical intent identifier rules and custom-Shield composition.
- Add an APLRET example with first-turn defer and second-turn token-matched approval/rejection.

## Acceptance Criteria

1. A listed domain intent cannot reach Execution without a matching unconsumed consent receipt.
2. Approval executes the exact intent at most once; rejection and replay never execute it.
3. Custom Shield behavior composes in the documented order.
4. Agents without configured intent consent retain existing behavior.
5. Consent state survives durable task restore.
6. TurnTrace is useful and redacted.
7. Unit, turn-script, persistence/resume, regression, type, and full CallAgent suites pass.

## Downstream Handoff

After release, communicate the package versions and the canonical manifest/receipt behavior. The dependent SiteConfig activation agent will declare its activation intent in `requireConsentFor.intents` and remain disabled until the released runtime enforces this contract.
