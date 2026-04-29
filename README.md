# callAgent

callAgent is a TypeScript framework for building agents with the APLRET architecture:

`Attention -> Perception -> Learning -> Reasoning/Policy -> Shield -> Execution -> Transition`

The project is also referred to as the APLRET framework. The canonical contract is [apps/docs/0-aplret_contracts.md](apps/docs/0-aplret_contracts.md). When README guidance and the contracts differ, the contracts document wins.

## Why Use It

Most agent code becomes hard to change when reasoning, memory writes, tool calls, LLM calls, retries, and transport details live in the same function. callAgent gives those concerns explicit places to live.

Use it when you need agents that:

- survive multi-turn workflows with input/tool/child-agent resumes
- sleep while waiting and wake with state restored
- keep reasoning state separate from runtime control state
- use LLMs and tools without hiding effects inside Policy
- store compact, durable memory instead of bloated prompt history
- coordinate multiple agents through durable threads and topics
- produce traces you can test and debug turn by turn

The tradeoff is intentional structure. Simple agents stay small; non-trivial agents get a layout that remains readable after the third branch, retry path, or integration.

## What APLRET Enforces

APLRET is a turn-based architecture built around explicit boundaries:

- **Perception reads only the current inbox**: runtime input arrives as observations in `env.inbox.current`.
- **Learning is the only writer of cognition**: durable reasoning state lives in `MentalState`.
- **Policy is synchronous and M-only**: no `ctx`, no `env`, no I/O, no LLM calls.
- **Execution is the only effect boundary**: LLM calls, tools, user replies, child agents, and conversation APIs live here.
- **Transition controls flow**: `continue`, `await_input`, `await_tool`, `await_child`, `complete`, or `fail`.
- **TurnTrace is the debugging unit**: one structured trace per turn, with compact module output and provenance.

The intended data flow is:

```txt
Execution -> ExecOutcome -> Transition -> Observation[]
  -> env.inbox.current on the next turn
  -> Perception -> Learning -> MentalState -> Policy
```

## Packages

This repository is a Yarn workspace monorepo.

| Package | Purpose |
|---------|---------|
| `@a2arium/callagent-core` | Runtime loop, `createAgent`, orchestration, test harness, TurnTrace, StageFacade, scaffold API |
| `@a2arium/callagent-types` | Shared types, manifest schemas, public error types |
| `@a2arium/callagent-memory-engine` | Memory registry and working memory facade |
| `@a2arium/callagent-memory-sql` | SQL-backed memory/session persistence with Prisma |
| `@a2arium/callagent-chat-bridge` | Chat routing, session mapping, and reply bridge |
| `@a2arium/callagent-eventbus-nats` | Optional NATS JetStream adapters for event bus, message log, and transport |
| `@a2arium/callagent-utils` | Shared utilities and logging |

## Feature Overview

### APLRET Runtime

The loop makes each turn explicit. Perception normalizes observations, Learning writes cognition, Policy chooses a typed intent, Shield guards it, Execution performs effects, and Transition decides whether to continue, await, complete, or fail.

This gives you stable places for code review and tests:

- closed `Obs`, `Intent`, and `Stage` unions in `types.ts`
- selector-driven Policy
- reducer-style Learning
- named effect handlers
- structured execution outcomes and transition outcomes

### Memory

callAgent treats memory as cognition, not a scratchpad.

The core contract is `MentalState`:

- `memory.sensory`: latest normalized facts needed by Policy
- `memory.window` / `memory.scratch`: short-lived working sets
- `memory.longTerm.semantic`: durable facts and entities
- `memory.longTerm.episodic`: compact history and audit summaries
- `memory.longTerm.procedural`: durable skills or routines
- `worldModel`, `goalState`, and `plans`: decision-ready cognition

Only Learning writes `MentalState`. Policy reads it synchronously. Execution may read it to act, but does not mutate it.

For persistence, `@a2arium/callagent-memory-engine` provides the memory registry/facade layer and `@a2arium/callagent-memory-sql` provides SQL-backed storage with Prisma/PostgreSQL. Large payloads should be kept as artifact handles plus compact derived facts, not inline memory blobs. See [Memory model](apps/docs/0-aplret_contracts.md#memory-model), [Artifact model](apps/docs/7-how_to_use_artifacts_correctly_aplret.md), and [memory-sql setup](packages/memory-sql/README.md).

### Persistent State and Wake-Up

Agents are not forced to stay hot while waiting. When a turn ends with `await_input`, `await_tool`, or `await_child`, the runtime persists the task snapshot: `MentalState`, inbox history, pending tokens, control state, manifest provenance, LLM state when configured, and other resume metadata.

When the awaited event arrives later, the task wakes up from that snapshot. The next turn sees the restored cognition and control state plus the new observation in `env.inbox.current`. That means long-running workflows can pause between user replies, tool completions, child-agent completions, or conversation deliveries without losing where they were.

With SQL-backed session storage, this state can survive process restarts and cross-runtime delivery. In-memory storage is useful for tests and local development, but not for production durability.

### Event Bus, Outbox, and Transports

The core runtime includes typed event-bus and message-log surfaces for durable orchestration:

- `IEventBus` publishes typed `BusEvent` envelopes.
- `MessageLog` stores ordered conversation messages.
- Outbox publishing lets persisted work be dispatched reliably.
- Durable subscription support tracks cursors, retries, and dead-letter paths.
- In-memory adapters are useful for local development and tests.
- `@a2arium/callagent-eventbus-nats` adds optional NATS JetStream adapters for cross-runtime event bus and message log use.

Most agent authors do not call these directly; they use higher-level APIs such as `ctx.conversation.*`, the task engine, and the test harness. Integrators can swap adapters at the composition root. See [multi-agent conversation](apps/docs/15-how_to_multiagent_conversation.md), [event bus migration notes](apps/docs/migration/5.4b-conversation-phase-4b-durable-subscription-and-outbox-bus-wiring-migration.md), and [NATS adapter notes](apps/docs/migration/5.4c-conversation-phase-4c-cross-runtime-transport-adapters-migration.md).

### Multi-Agent Conversations

callAgent supports durable agent-to-agent conversation primitives:

- **Threads**: 1:1 ordered exchanges between two agents.
- **Topics**: N-member rooms with broadcast, round-robin, explicit recipient, selector policies, invites, stop policies, and projections.
- **MessageLog**: the durable ordered record of conversation messages.

The rule is the same as every other effect: Policy may decide to send, post, close, or archive, but only Execution calls `ctx.conversation.*`. Inbound messages re-enter cognition as `conversation` observations.

See [apps/docs/15-how_to_multiagent_conversation.md](apps/docs/15-how_to_multiagent_conversation.md).

### LLMs, Tools, Children, and Artifacts

LLMs, tools, and child-agent dispatch are effects. Policy emits typed intents; Execution performs the call; Transition emits observations; Learning writes the result into cognition on a later turn.

For structured LLM/tool output, define explicit contracts with Zod or JSON Schema. For large data, use artifact handles and store compact facts in memory. See [LLM usage](apps/docs/10-how_to_use_llm_in_aplret.md), [child-agent await/resume](apps/docs/6-how_to_child_agent_await_and_resume_aplret.md), and [artifacts](apps/docs/7-how_to_use_artifacts_correctly_aplret.md).

### Testing and Observability

Every turn can emit one `TurnTrace` with compact module outputs, stage transitions, intent, shield outcome, execution result, transition outcome, timings, usage, and sub-call summaries.

The test harness lets you inject observations, run turns, resume awaited tokens, and assert traces directly. This is much more stable than checking only final text. See [testing](apps/docs/11-how_to_test_aplret_agents.md) and [TurnTrace debugging](apps/docs/12-how_to_debug_with_turn_trace.md).

### Chat Bridge

`@a2arium/callagent-chat-bridge` normalizes chat messages from Telegram, Slack, web chat, or custom networks; maps chat sessions to agent tasks; routes start vs resume; forwards replies/progress/input-required events; and supports optional realtime publishing.

See [packages/chat-bridge/README.md](packages/chat-bridge/README.md).

## Installation

For a normal agent project:

```bash
yarn add @a2arium/callagent-core @a2arium/callagent-types
```

or:

```bash
npm install @a2arium/callagent-core @a2arium/callagent-types
```

Add persistence when you need SQL-backed memory/session storage:

```bash
yarn add @a2arium/callagent-memory-engine @a2arium/callagent-memory-sql
```

Add optional integrations as needed:

```bash
yarn add @a2arium/callagent-chat-bridge
yarn add @a2arium/callagent-eventbus-nats
```

This repo uses Yarn 4 workspaces. For framework development:

```bash
yarn install
yarn build
yarn test
```

## Start a New Agent

Use the scaffold first. It creates manifests, TypeScript config, module files, and tests that match the framework contracts.

In a downstream project after installing `@a2arium/callagent-core`:

```bash
node node_modules/@a2arium/callagent-core/dist/scaffold/scaffoldCli.js \
  --name my-agent --preset minimal --output ./my-agent
```

For a non-trivial agent with a `flow.md` map, normalizers, selectors, reducers, and test stubs:

```bash
node node_modules/@a2arium/callagent-core/dist/scaffold/scaffoldCli.js \
  --name my-agent --preset non-trivial --output ./my-agent \
  --uses-llm --uses-tools --uses-children --uses-plans
```

Inside this monorepo, use the convenience script:

```bash
yarn create-agent --name my-agent --preset minimal --output apps/examples/my-agent
```

The scaffold produces an `agent.ts` that wires modules through `createAgent(...)`. `createAgent` resolves `agent-card.json` and `agent-runtime.json` by default relative to the agent module. It returns an agent plugin promise; the framework loaders and existing examples export that result directly.

After scaffolding:

```bash
cd my-agent
yarn install
yarn build
yarn test
```

## Minimal Agent Shape

A minimal agent usually has:

```txt
my-agent/
  agent.ts
  types.ts
  attention.ts
  perception.ts
  learning.ts
  policy.ts
  shield.ts
  execution.ts
  transition.ts
  agent-card.json
  agent-runtime.json
  tests/golden.test.ts
```

The wiring stays small:

```ts
import { createAgent } from '@a2arium/callagent-core';
import { attention } from './attention.js';
import { perception } from './perception.js';
import { learning } from './learning.js';
import { policy } from './policy.js';
import { shield } from './shield.js';
import { execution } from './execution.js';
import { transition } from './transition.js';
import type { Sensory, Obs, ExecPayload, ExecError } from './types.js';

export default createAgent<Sensory, Obs, unknown, ExecPayload, ExecError>(
  {
    attention,
    perception,
    learning,
    policy,
    shield,
    execution,
    transition,
  },
  import.meta.url
);
```

For the complete canonical example, see [apps/docs/0-aplret_contracts.md](apps/docs/0-aplret_contracts.md#minimal-canonical-example) and [apps/docs/1-tutorial_build_your_first_aplret_agent.md](apps/docs/1-tutorial_build_your_first_aplret_agent.md).

## Basic Usage

Build and test a scaffolded agent:

```bash
cd my-agent
yarn build
yarn test
```

Inside this monorepo, run the minimal example:

```bash
yarn workspace @a2arium/hello-agent build
yarn run:hello
```

The runner sends JSON input to the agent. The agent receives it as a `user / input.provided` observation, Perception normalizes it, Learning stores the compact fact, Policy chooses the next intent, Execution replies, and Transition completes the run.

## Manifests

Every agent has two manifests:

- `agent-card.json`: public A2A discovery contract.
- `agent-runtime.json`: local callAgent runtime configuration.

The runtime enforces that `name` and `version` match between both manifests. Default resolution is:

1. inline manifest source passed to `createAgent`
2. explicit path source passed to `createAgent`
3. default files next to the agent module

See [apps/docs/2-manifest_spec_agent_card_runtime_manifest.md](apps/docs/2-manifest_spec_agent_card_runtime_manifest.md).

## Testing

APLRET agents should be tested as turn scripts:

1. seed or inject observations
2. run a turn
3. assert `TurnTrace`
4. inject resume observations for awaited inputs, tools, or children
5. repeat until complete or failed

The core package exports `createTestHarness`, deterministic LLM/tool stubs, and assertion helpers. Scaffolded agents include starter tests.

Framework contributor commands:

```bash
yarn build
yarn test
yarn workspace @a2arium/callagent-core test:types
```

The full test suite is intentionally broad and can be noisy. For agent work, prefer focused harness tests plus the relevant workspace tests.

See [apps/docs/11-how_to_test_aplret_agents.md](apps/docs/11-how_to_test_aplret_agents.md) and [apps/docs/12-how_to_debug_with_turn_trace.md](apps/docs/12-how_to_debug_with_turn_trace.md).

## Repository Layout

Important top-level paths:

```txt
packages/
  core/
  types/
  memory-engine/
  memory-sql/
  chat-bridge/
  eventbus-nats/
  utils/

apps/
  docs/
  examples/
  functions/

planned_architecture/
scripts/
```

Non-trivial agents should keep behavior visible:

- `types.ts`: closed `Obs`, intent, stage, and execution unions.
- `flow.md`: behavior over turns, branches, awaits, and terminal outcomes.
- `normalizers/`: source-specific inbox normalization.
- `selectors.ts`: decision-ready views for Policy.
- `reducers.ts`: Learning-owned cognition updates.
- `effects/`: named execution-side effect handlers.
- `contracts/`: Zod or JSON schemas for structured LLM/tool output.
- `prompts/`: prompt builders and wording.

See [apps/docs/14-agent_repository_layout_for_aplret.md](apps/docs/14-agent_repository_layout_for_aplret.md) and [apps/docs/13-flow_md_for_aplret_agents.md](apps/docs/13-flow_md_for_aplret_agents.md).

## Examples

Current example agents:

| Example | Purpose |
|---------|---------|
| [hello-agent](apps/examples/hello-agent/) | Minimal scaffolded APLRET loop |
| [flow-reference-agent](apps/examples/flow-reference-agent/) | Non-trivial reference layout with `flow.md`, selectors, reducers, normalizers, effects, prompts, contracts, and tests |
| [conversation-reference-agent](apps/examples/conversation-reference-agent/) | Canonical thread initiator example |
| [conversation-responder-agent](apps/examples/conversation-responder-agent/) | Companion thread responder |
| [conversation-panel-orchestrator-agent](apps/examples/conversation-panel-orchestrator-agent/) | Panel orchestration example |
| [conversation-panel-persona-agent](apps/examples/conversation-panel-persona-agent/) | Persona seat for panel-style conversation |
| [ethical-triage-panel-agent](apps/examples/ethical-triage-panel-agent/) | Moderated topic/panel example with projections, selectors, stop policy, and transcript output |

Useful monorepo commands:

```bash
yarn workspace @a2arium/hello-agent build
yarn run:hello

yarn workspace @a2arium/flow-reference-agent build
yarn workspace @a2arium/flow-reference-agent test
```

## Documentation Map

Canonical docs in `apps/docs`:

| Document | Use it for |
|----------|------------|
| [0-aplret_contracts.md](apps/docs/0-aplret_contracts.md) | Stable APLRET contracts and public API discipline |
| [1-tutorial_build_your_first_aplret_agent.md](apps/docs/1-tutorial_build_your_first_aplret_agent.md) | First agent tutorial and scaffold workflow |
| [2-manifest_spec_agent_card_runtime_manifest.md](apps/docs/2-manifest_spec_agent_card_runtime_manifest.md) | Agent Card and Runtime Manifest rules |
| [3-how_to_keep_policy_pure.md](apps/docs/3-how_to_keep_policy_pure.md) | Policy purity and effect boundaries |
| [5-how_to_use_stage_facade_in_aplret.md](apps/docs/5-how_to_use_stage_facade_in_aplret.md) | StageFacade and control invariants |
| [10-how_to_use_llm_in_aplret.md](apps/docs/10-how_to_use_llm_in_aplret.md) | LLM effects and structured output contracts |
| [11-how_to_test_aplret_agents.md](apps/docs/11-how_to_test_aplret_agents.md) | Harness and TurnTrace testing |
| [12-how_to_debug_with_turn_trace.md](apps/docs/12-how_to_debug_with_turn_trace.md) | TurnTrace debugging |
| [13-flow_md_for_aplret_agents.md](apps/docs/13-flow_md_for_aplret_agents.md) | `flow.md` format |
| [14-agent_repository_layout_for_aplret.md](apps/docs/14-agent_repository_layout_for_aplret.md) | Agent repository layout |
| [15-how_to_multiagent_conversation.md](apps/docs/15-how_to_multiagent_conversation.md) | Threads, topics, selectors, projections, and transports |
| [16-observation_envelope_and_validation.md](apps/docs/16-observation_envelope_and_validation.md) | Observation envelopes and validation |

Migration notes live in [apps/docs/migration](apps/docs/migration). Drafts and future work live under `apps/docs/drafts` and `apps/docs/todo`.

## Contributor Rules

Treat the framework as a contract:

- Keep public API changes aligned with the inventory in [apps/docs/0-aplret_contracts.md](apps/docs/0-aplret_contracts.md#public-api-inventory-single-source-of-truth).
- Add type-level tests when exported types change.
- Add or update migration notes for author-visible behavior changes.
- Reference examples should use stable public surfaces only.
- Keep README claims tied to actual packages, examples, and docs in the repo.

## License

Package licenses are declared in each package's `package.json`.
