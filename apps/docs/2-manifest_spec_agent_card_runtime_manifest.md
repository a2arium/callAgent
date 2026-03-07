# Manifest Spec: Agent Card + Runtime Manifest

This document is normative. It defines the manifest standard for callagent agents that must be A2A-compatible.

It uses RFC 2119 keywords: MUST, SHOULD, MAY.

## Overview

This standard defines two manifests:

1. **Agent Card** (public discovery contract; A2A-compliant)
2. **Runtime Manifest** (local execution contract; callagent-owned)

The Agent Card is the public interface and must remain compatible with A2A.

The Runtime Manifest configures callagent runtime behavior and is not part of the public A2A contract.

## Files and locations

### Agent Card file

- The agent repository MUST contain `agent-card.json` at the repository root.
- The runtime MUST serve the same content at `/.well-known/agent-card.json`.
- The runtime MAY also serve the same content at `/agent-card.json`.
- If multiple paths are served, their content MUST be semantically identical.

### Runtime Manifest file

- The agent repository MUST contain `agent.runtime.json` at the repository root.
- The runtime MUST load `agent.runtime.json` by default.
- The runtime MAY allow an override path via CLI/env/constructor.
- If an override is used, the runtime SHOULD still support `agent.runtime.json` as the default convention.

## Identity and versioning

- `AgentCard.name` and `AgentCard.version` define agent identity.
- `agent.runtime.json` MUST include `name` and `version`.

## Resolution Rules (v2)

### Inputs to createAgent
The runtime MUST support manifest inputs from `path: string` or `inline: object`.

```ts
type ManifestSource<T> = { path: string } | { inline: T };

type CreateAgentOptions = {
  agentCard?: ManifestSource<AgentCard>;
  runtimeManifest?: ManifestSource<AgentRuntimeManifestV1>;
};
```

### Precedence
Both Agent Card and Runtime Manifest are resolved independently using this precedence:
1. `inline` object if provided
2. `path` override if provided
3. default file path (`./agent-card.json` or `./agent.runtime.json`)

The runtime MUST NOT implicitly merge file-based and inline manifests. 

## Validation Rules (v2)

After resolving both manifests, the runtime MUST:
1. Validate the Agent Card against the A2A Agent Card schema
2. Validate the Runtime Manifest against the callagent runtime schema
3. Enforce identity matching:
   - `RuntimeManifest.name === AgentCard.name`
   - `RuntimeManifest.version === AgentCard.version`

If the resolved manifests cannot be loaded, parsed, or if identity does not match, the runtime MUST fail fast at startup with a structured configuration error.

## Serving Rules (v2)

Serving MUST reflect the **resolved** Agent Card.
- The framework MUST serve the resolved card at `/.well-known/agent-card.json`.
- If `/agent-card.json` is also served, it MUST return the exact same resolved card.
- Serving MUST NOT be based on “whatever file exists” if the runtime is using an inline or path override source.

## Manifest A: Agent Card (A2A)

### Purpose

The Agent Card is the A2A discovery document.

It answers:

- who the agent is
- what it can do (skills)
- how to talk to it (supported interfaces)
- what modes it accepts and returns
- what optional extensions it supports

### Contract

- `agent-card.json` MUST be valid per the A2A Agent Card specification.
- callagent-specific runtime fields MUST NOT be added as ad-hoc top-level fields.
- callagent-specific public metadata MUST be published via an A2A extension declaration.

### Required fields (minimum)

The Agent Card MUST include at least:

- `name`
- `description`
- `version`
- `supportedInterfaces`
- `capabilities`
- `defaultInputModes`
- `defaultOutputModes`
- `skills`

Additional A2A fields MAY be included when relevant (e.g., `provider`, `securitySchemes`, `security`, `documentationUrl`, `iconUrl`, `signatures`).

### Skills

- Each skill MUST have a stable `id`.
- Skills SHOULD declare `inputModes` and `outputModes`.
- Skill IDs MUST be treated as public API.

### I/O modes

- Modes MUST be MIME types.
- The Agent Card MUST include `defaultInputModes` and `defaultOutputModes`.

## Manifest B: Runtime Manifest (callagent)

### Purpose

The Runtime Manifest configures execution behavior in callagent:

- loop budgets
- caching
- safety and HITL policy
- observability toggles
- feature flags and validation knobs

### Contract

- `agent.runtime.json` MUST conform to the schema in this document.
- All fields except `name` and `version` MUST be optional.
- The runtime MUST define defaults for omitted fields.

### Schema (normative)

```ts
type AgentRuntimeManifestV1 = {
  /** MUST match AgentCard.name */
  name: string;
  /** MUST match AgentCard.version */
  version: string;

  /** Optional reference to the public Agent Card URL (useful in deployments). */
  agentCardRef?: string;

  /** Loop budgets (control-plane constraints). */
  budgets?: {
    /** Maximum loop iterations for a single run. */
    maxTurns?: number;
    /** Maximum total latency budget for a run. */
    latencyMs?: number;
    /** Optional: cap concurrent effects (tools/children) per turn. */
    maxConcurrentEffects?: number;
  };

  /** Human-in-the-loop policy. */
  hitl?: {
    level?: 'advise' | 'consent' | 'guardrails';
    requireConsentFor?: {
      intents?: string[];
      tools?: string[];
    };
  };

  /** Safety configuration. */
  safety?: {
    sanitize?: boolean;
    piiPatterns?: string[];
    costLimitUsd?: number;
    /** Defines how validation failures are handled. */
    mode?: 'transform' | 'reject';
  };

  /** Result caching behavior for agent calls. */
  cache?: {
    enabled?: boolean;
    ttlSeconds?: number;
    excludePaths?: string[];
  };

  /** Runtime feature flags and validation knobs. */
  config?: {
    enableValidation?: boolean;
    validationCoverageThreshold?: number;
    featureFlags?: Record<string, boolean>;
  };

  /** Optional: dependencies used for packaging or deployment. */
  dependencies?: {
    agents?: string[];
  };

  /** Optional: observability toggles. */
  observability?: {
    turnTrace?: {
      enabled?: boolean;
      /** 'full' for dev, 'summary' for prod. */
      level?: 'summary' | 'full';
    };
    logs?: {
      level?: 'debug' | 'info' | 'warn' | 'error';
    };
  };
};
```

### Observability and Provenance (v2)
To keep execution diagnosable, the runtime SHOULD record manifest provenance. If TurnTrace is enabled, each run MUST record:
- `agentCardSource: 'defaultPath' | 'pathOverride' | 'inline'`
- `runtimeManifestSource: 'defaultPath' | 'pathOverride' | 'inline'`
- `agentCardHash`
- `runtimeManifestHash`

At startup, the runtime SHOULD log the resolved agent name/version, sources, and hashes.

### Runtime access rule

Policy remains sync and M-only.

Therefore:

- runtime manifest data MUST NOT be read directly by Policy
- reasoning-relevant config MUST be materialized into `MentalState.policyParams` before Policy runs

Allowed sources for `policyParams`:

- bootstrap initialization
- Learning updates from `env/config.updated` observations

## callagent A2A Extension

### Purpose

Some callagent-specific metadata may be useful to A2A clients.

This data is published as an optional A2A extension.

### URI (normative)

Until a project domain exists, callagent uses a GitHub URL as a stable namespace identifier:

- `https://github.com/a2arium/callagent/extensions/callagent/v1`

### Declaration

If the agent supports the callagent extension, the Agent Card MUST include an entry in `capabilities.extensions` with:

- `uri` equal to the URI above
- `required: false`

### Params

Extension params MUST be treated as hints by clients.

callagent agents MAY include extension params. If included, they MUST be additive-only within `v1`.

Recommended param shape (optional):

```ts
type CallagentExtensionParamsV1 = {
  runtime?: {
    loop?: boolean;
    turnTrace?: boolean;
  };
  limits?: {
    maxTurnsHint?: number;
    latencyMsHint?: number;
  };
};
```

## Input/Output schemas (structured data)

### Baseline rule

When structured data is expected or returned, the agent MUST attach a JSON Schema at the Part level.

This applies to:

- A2A messages sent to the agent
- A2A messages returned by the agent
- A2A artifacts produced by the agent

### Required fields for a structured JSON part

For any Part carrying JSON:

- `metadata.mediaType` MUST be `application/json`
- `metadata.schema` MUST be a JSON Schema object (draft-2020-12 compatible)
- the part MUST contain the JSON payload (as `data` or the framework’s equivalent)

### Schema requirements

- the schema MUST include `$id`
- the schema SHOULD include `title`
- the schema SHOULD include a `version` field under `schemaVersion` or equivalent
- schemas SHOULD be stable and versioned

### Example: JSON DataPart with schema

```json
{
  "parts": [
    {
      "kind": "data",
      "metadata": {
        "mediaType": "application/json",
        "schema": {
          "$id": "https://schemas.example.com/invoice-lookup-request/v1",
          "title": "InvoiceLookupRequest",
          "type": "object",
          "properties": {
            "invoiceId": { "type": "string" }
          },
          "required": ["invoiceId"],
          "additionalProperties": false
        }
      },
      "data": {
        "invoiceId": "inv_123"
      }
    }
  ]
}
```

### Skill-level schemas

A2A skill discovery is mode-based.

Therefore:

- schemas are primarily enforced at runtime via Part metadata
- if the project later adds skill-level schema URLs, they MUST be introduced via an extension (not as ad-hoc Agent Card fields)

## Validation and enforcement

### Startup checks

At startup, the runtime MUST load and validate the manifests according to the **Resolution Rules** and **Validation Rules** defined above.

### Runtime checks

At runtime, the framework SHOULD:

- validate structured JSON parts against their attached schema
- surface validation failures as structured Perception errors or invariant errors

## Versioning

- Any breaking change to Agent Card semantics is a public breaking change.
- Any breaking change to `agent.runtime.json` schema requires bumping this spec version.
- Any breaking change to the callagent extension requires a new URI with `/v2`.

