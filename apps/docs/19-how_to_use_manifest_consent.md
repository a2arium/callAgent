# How-to: Use Manifest Intent Consent

Use manifest consent for a specific domain action that must pause for an explicit structured decision before Execution.

## Declare the obligation

```json
{
  "name": "site-config",
  "version": "1.0.0",
  "hitl": {
    "consentTtlMs": 86400000,
    "requireConsentFor": { "intents": ["activate_bundle"] }
  }
}
```

The closed Intent union represents this action as:

```ts
{ kind: 'internal', intent: 'activate_bundle', data: { bundleId } }
```

Other declarable built-ins use `kind`. Declare tool names under `requireConsentFor.tools`; do not list generic wrappers as domain identifiers.

## Runtime flow

1. Policy proposes the intent.
2. Shield may pass, transform, veto, or defer it.
3. The runtime matches the final passed/transformed intent. A listed intent creates a private durable receipt and returns `await_input` without calling agent Execution.
4. Resume with the exact token and `{ "decision": "approve" }` or `{ "decision": "reject" }`.
5. Learning may consume the normalized framework observation. Policy must re-propose the exact intent; a changed payload has a different digest and needs new consent.
6. Before approved Execution, the runtime persists `dispatching` and sets `ctx.effect.idempotencyKey`.

```ts
execution: async (intent, ctx) => {
  if (intent.kind === 'internal' && intent.intent === 'activate_bundle') {
    return activateBundle(intent.data, {
      idempotencyKey: ctx.effect!.idempotencyKey,
    });
  }
  // other actions
}
```

The effect store must enforce uniqueness for that key. CallAgent workers are at-least-once: a crash after the external effect but before the final snapshot can call Execution again with the same key.

Gated intents must be canonical-JSON values (plain objects, arrays, finite numbers, strings, booleans, and null). Circular values, class instances, dates, functions, `undefined`, and other non-JSON payloads are rejected because they cannot be bound exactly.

## Expiry, rejection, and privacy

Consent defaults to 24 hours. Rejection, timeout, cancellation, token mismatch, malformed input, and replay never authorize Execution. Receipts live in private pending control state, not MentalState. `TurnTrace.manifestConsent` contains only the action, reason, identifier, token presence, and status; it omits intent payloads, digests, and effect keys.
