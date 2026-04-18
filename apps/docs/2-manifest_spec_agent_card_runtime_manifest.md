# Manifest Spec: Agent Card + Runtime Manifest

This document is normative for CallAgent. It defines the CallAgent manifest model.

It uses RFC 2119 keywords: MUST, SHOULD, MAY.

## Overview

This specification defines two manifests:

1. **Agent Card** (public discovery contract; A2A-compatible)
2. **Runtime Manifest** (local execution contract; CallAgent-owned)

The Agent Card is the public interface and MUST remain compatible with the A2A Agent Card model.

The Runtime Manifest configures CallAgent runtime behavior and is not part of the public A2A contract.

## Scope and rule types

This document contains three kinds of rules:

* **A2A requirements**: rules inherited from the A2A protocol for the public Agent Card
* **CallAgent requirements**: rules enforced by CallAgent for manifest resolution, validation, serving, and runtime loading
* **CallAgent conventions**: recommended file names and default locations used by CallAgent

Unless explicitly stated otherwise, rules in this document are **CallAgent requirements**.

## Files and locations

### Agent Card file

* By convention, the agent project SHOULD contain `agent-card.json` at the project root.
* If the runtime exposes an A2A server, it MUST serve the resolved Agent Card at `/.well-known/agent-card.json`.
* The runtime MAY also serve the same resolved Agent Card at `/agent-card.json`.
* If multiple paths are served, their content MUST be semantically identical.

### Runtime Manifest file

* By convention, the agent project SHOULD contain `agent-runtime.json` at the project root.
* The runtime MUST load `agent-runtime.json` by default unless an override path or inline manifest is provided.
* The runtime MAY allow an override source via CLI, environment, or constructor.
* If an override is used, the runtime SHOULD still support `agent-runtime.json` as the default convention.
* The Runtime Manifest MUST NOT be exposed as an A2A discovery document.

## Identity and versioning

* `AgentCard.name` and `AgentCard.version` define public agent identity.
* `agent-runtime.json` MUST include `name` and `version`.
* CallAgent MUST enforce identity matching:

  * `RuntimeManifest.name === AgentCard.name`
  * `RuntimeManifest.version === AgentCard.version`

If the resolved manifests cannot be loaded, parsed, or if identity does not match, the runtime MUST fail fast at startup with a structured configuration error.

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
3. default file path (`./agent-card.json` or `./agent-runtime.json`)

Default paths are resolved relative to the module or base location supplied to `createAgent`.

The runtime MUST NOT implicitly merge file-based and inline manifests.

## Validation Rules (v2)

After resolving both manifests, the runtime MUST:

1. Validate the Agent Card against the A2A Agent Card schema
2. Validate the Runtime Manifest against the CallAgent runtime schema
3. Enforce identity matching:

   * `RuntimeManifest.name === AgentCard.name`
   * `RuntimeManifest.version === AgentCard.version`

If the resolved manifests cannot be loaded, parsed, validated, or if identity does not match, the runtime MUST fail fast at startup with a structured configuration error.

### Unknown fields

* The runtime MAY reject unknown top-level fields in `agent-runtime.json` if the schema is strict.
* If custom runtime settings are allowed, they SHOULD be placed under `config` rather than as ad-hoc top-level fields.

## Serving Rules (v2)

Serving MUST reflect the **resolved** Agent Card.

* The framework MUST serve the resolved card at `/.well-known/agent-card.json`.
* If `/agent-card.json` is also served, it MUST return the same resolved card.
* Serving MUST NOT be based on “whatever file exists” if the runtime is using an inline or path override source.

## Manifest A: Agent Card (A2A)

### Purpose

The Agent Card is the A2A discovery document.

It answers:

* who the agent is
* what it can do
* how to talk to it
* what interfaces it supports
* what input and output modes it uses
* what optional extensions it supports

### Contract

* `agent-card.json` MUST be valid per the A2A Agent Card specification (https://a2a-protocol.org/v1.0.0/specification)
* CallAgent-specific runtime fields MUST NOT be added as ad-hoc top-level fields.
* CallAgent-specific public metadata MUST be published via an A2A-compatible extension mechanism under the Agent Card capabilities structure.

### Required fields (minimum)

The Agent Card MUST include at least:

* `name`
* `description`
* `version`
* `supportedInterfaces`
* `capabilities`
* `defaultInputModes`
* `defaultOutputModes`
* `skills`

Additional A2A fields MAY be included when relevant, for example:

* `provider`
* `securitySchemes`
* `security`
* `documentationUrl`
* `iconUrl`

### Supported Interfaces

`supportedInterfaces` MUST be an array of `AgentInterface` objects, where each object contains:

* `url` (required): A valid absolute URL. In production, MUST be HTTPS. Local development MAY use HTTP.
* `protocolBinding` (required): One of `JSONRPC`, `GRPC`, or `HTTP+JSON`
* `protocolVersion` (required): The protocol version string (e.g., "1.0")

Example:
```json
{
  "supportedInterfaces": [
    {
      "url": "https://agent.example.com/a2a/v1",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ]
}
```

### Media Types

`defaultInputModes` and `defaultOutputModes` MUST be arrays of media type strings (MIME types), following RFC 2045 and RFC 6838.

Valid examples:
* `"text/plain"` - Plain text
* `"application/json"` - JSON data
* `"text/html"` - HTML content
* `"image/png"` - PNG images
* `"application/pdf"` - PDF documents

### Skills

* Each skill MUST have a stable `id`.
* Skills SHOULD declare `inputModes` and `outputModes` (as media type strings) when relevant.
* Skills MAY include `tags` for categorization and `examples` for documentation.
* Skill IDs SHOULD be treated as public API.

**Skill ID Naming Convention:**

For agents with a single primary skill, it is RECOMMENDED that the skill ID match or closely resemble the agent name. This improves discoverability and reduces cognitive overhead for users interacting with A2A agents.

**Examples:**
* Agent: `"scrape-listing"` → Main skill ID: `"scrape-listing"`
* Agent: `"data-analyzer"` → Main skill ID: `"data-analyzer"`
* Agent: `"research-assistant"` → Main skill ID: `"research-assistant"`

For agents with multiple related skills, consider using a consistent prefix:
* `"scrape-listing"` (primary)
* `"scrape-listing-detail"` (related)
* `"scrape-listing-pagination"` (related)

This naming convention makes the A2A discovery model more intuitive and aligns with the principle of least surprise—when someone calls an agent, they expect to find a skill with a matching identifier.

### Capabilities

The `capabilities` object declares optional features:

* `streaming` (boolean): Whether the agent supports streaming operations
* `pushNotifications` (boolean): Whether the agent supports webhook push notifications
* `extendedAgentCard` (boolean): Whether the agent provides an authenticated extended agent card
* `stateTransitionHistory` (boolean): Whether the agent tracks state transition history
* `extensions` (array): Optional A2A extensions

### Security guidance

* The public Agent Card SHOULD NOT contain secrets, credentials, or private internal implementation details.
* If the Agent Card contains sensitive operational metadata, access to the served card SHOULD be protected appropriately.

### Example Agent Card

```json
{
  "name": "example-agent",
  "description": "An example agent demonstrating A2A compliance",
  "version": "1.0.0",
  "supportedInterfaces": [
    {
      "url": "https://example.com/a2a/v1",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "example-skill",
      "name": "Example Skill",
      "description": "A skill that demonstrates the agent's capabilities",
      "tags": ["example", "demo"],
      "examples": ["Do something example", "Help me with X"],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain"]
    }
  ]
}
```

### Local Development Example

For local development, HTTP URLs are acceptable:

```json
{
  "supportedInterfaces": [
    {
      "url": "http://localhost:3000/a2a/v1",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ]
}
```

**Important:** Production deployments MUST use HTTPS URLs in `supportedInterfaces`.

## Manifest B: Runtime Manifest (CallAgent)

### Purpose

The Runtime Manifest configures execution behavior in CallAgent:

* loop budgets
* caching
* safety and HITL policy
* observability toggles
* feature flags and validation knobs
* internal dependencies

### Contract

* `agent-runtime.json` MUST conform to the schema in this document.
* All fields except `name` and `version` MAY be optional.
* The runtime MUST define defaults for omitted fields.

### Schema (normative)

```ts
type AgentRuntimeManifestV1 = {
  /** MUST match AgentCard.name */
  name: string;
  /** MUST match AgentCard.version */
  version: string;

  /** Optional reference to the public Agent Card URL. */
  agentCardRef?: string;

  /** Execution budgets. */
  budgets?: {
    /** Maximum loop iterations for a single run. */
    maxTurns?: number;
    /** Maximum total latency budget for a run. */
    latencyMs?: number;
    /** Optional cap on concurrent effects per turn. */
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

  /** Result caching behavior. */
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

  /** Optional dependencies used for packaging or deployment. */
  dependencies?: {
    agents?: string[];
  };

  /** Optional observability controls. */
  observability?: {
    turnTrace?: {
      enabled?: boolean;
      level?: 'summary' | 'full';
    };
    logs?: {
      level?: 'debug' | 'info' | 'warn' | 'error';
    };
  };

  /** Optional communication runtime behavior. */
  communication?: {
    /**
     * When true, the loop attempts `ctx.conversation.join(...)` for
     * `topic.invite.received` observations before policy evaluation.
     * Default: false.
     */
    autoJoinInvitedTopics?: boolean;
    /**
     * Idle thread TTL in milliseconds. Default 3600000 (1 hour). Use `null` to disable TTL for this runtime.
     */
    threadTtlMs?: number | null;
    /**
     * While a `runLoop` is active, invoke the topic lifecycle sweeper (`triggerTopicLifecycleSweep`) for this
     * tenant when at least `intervalMs` of wall time has elapsed since the last sweep (checked at the start
     * of each loop turn). The first check may run immediately. Requires a framework `TaskEngine` on
     * `EngineLocator` (e.g. CLI / streaming runner). Omit to rely on manual sweeps only. See migration
     * `5.4a-conversation-phase-4a-…`.
     */
    topicSweeper?: {
      intervalMs: number;
      batchSize?: number;
      autoArchiveAfterMs: number;
    };
  };

  /**
   * Thread sweeper (idle TTL + optional auto-archive of closed threads). Defaults are runtime-defined; see migration 5.3.
   */
  conversation?: {
    threadSweeper?: {
      intervalMs?: number;
      batchSize?: number;
      /** Milliseconds after `closed_at` before sweeper may archive a closed thread; `null` disables auto-archive. */
      autoArchiveAfterMs?: number | null;
    };
  };
};
```

### Runtime semantics

The exact behavioral meaning of runtime fields such as `budgets`, `hitl`, `cache`, and `safety` MUST be defined by CallAgent runtime documentation.

This manifest spec defines the configuration surface, not every execution detail.

## CallAgent A2A Extension

### Purpose

Some CallAgent-specific public metadata may be useful to A2A clients.

This data SHOULD be published as an optional A2A-compatible extension.

### URI (normative)

Until a project domain exists, CallAgent MAY use a stable project-controlled URI as a namespace identifier, for example:

* `https://github.com/a2arium/callagent/extensions/callagent/v1`

### Declaration

If the agent supports the CallAgent extension, the Agent Card SHOULD include an entry in the relevant capabilities extension structure with:

* `uri` equal to the URI above
* `required` set appropriately for clients

Extension params SHOULD be treated as hints by clients unless explicitly documented otherwise.

### Params

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

Any future breaking change to the public extension contract SHOULD use a new versioned namespace.

## Startup and runtime enforcement

### Startup checks

At startup, the runtime MUST load and validate manifests according to the **Resolution Rules** and **Validation Rules** defined above.

### Runtime checks

At runtime, the framework MAY enforce additional behavior derived from the Runtime Manifest, such as:

* safety enforcement
* HITL enforcement
* caching behavior
* observability setup

These are CallAgent concerns, not A2A schema requirements.

## Versioning

* Any breaking change to Agent Card semantics is a public compatibility change and SHOULD be evaluated against the current A2A model.
* Any breaking change to `agent-runtime.json` schema SHOULD require a new runtime schema version.
* Any breaking change to the CallAgent extension SHOULD use a new versioned URI.

## Non-goals

This specification does not define:

* internal reasoning architecture
* policy engine execution order
* mental state propagation
* structured data validation rules beyond what CallAgent separately documents
* transport implementation details beyond what A2A requires for the public Agent Card
