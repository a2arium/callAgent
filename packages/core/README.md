# @a2arium/callagent-core

Core runtime package for callAgent, a TypeScript framework for durable, testable AI agents.

Use this package when an agent needs more than a single prompt call: multi-turn state, explicit policy/effect boundaries, tool or LLM effects, input resumes, child-agent resumes, conversation threads, and turn-level traces you can test.

Provider SDKs help you call a model. `@a2arium/callagent-core` helps you operate an agent.

For long-running work, `ctx.progress(...)` remains transient status while
`await ctx.progress.report?.(...)` stores a bounded, fenced latest-progress view
for Operator. Report only after the corresponding domain checkpoint commits.

## Installation

```bash
npm install @a2arium/callagent-core @a2arium/callagent-types
```

```bash
yarn add @a2arium/callagent-core @a2arium/callagent-types
pnpm add @a2arium/callagent-core @a2arium/callagent-types
```

Requirements:

- Node.js `>=20`
- ESM import support
- TypeScript declarations are included

## Create An Agent

Agent and workspace creation is provided by `@a2arium/callagent-cli`; core retains the programmatic `scaffoldAgent` API for tooling.

```bash
callagent create agent-project my-agents --with-agent my-agent
```

For a larger agent with a `flow.md`, selectors, reducers, effect folders, prompts, contracts, and test stubs:

```bash
callagent create agent my-agent --project ./my-agents --preset non-trivial \
  --uses-llm \
  --uses-tools \
  --uses-children \
  --uses-plans
```

Inside a generated agent project:

```bash
yarn install
yarn build
yarn test
```

## Minimal Shape

A minimal callAgent agent is a set of typed modules wired through `createAgent`.

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

The nearby `agent-card.json` and `agent-runtime.json` describe the public A2A card and local runtime manifest. The runtime validates that both manifests agree on identity.

## How The Runtime Thinks

callAgent uses the APLRET loop:

```txt
Attention -> Perception -> Learning -> Policy -> Shield -> Execution -> Transition
```

The important boundaries are:

- Perception reads the current inbox and normalizes observations.
- Learning is the only writer of durable cognition.
- Policy is synchronous and reads decision-ready state only.
- Shield validates or blocks the selected intent.
- Execution performs effects: LLM calls, tools, replies, child agents, and conversation APIs.
- Transition decides whether the task continues, waits, completes, or fails.

This structure is intentionally heavier than a direct model call. It pays off when workflows branch, pause, resume, retry, call tools, call children, or need reproducible traces.

## Public Entry Points

Stable root imports:

```ts
import {
  createAgent,
  createTestHarness,
  createStageFacade,
  TaskEngine,
  type TaskContext,
  type TurnTrace,
} from '@a2arium/callagent-core';
```

Runner-specific APIs live under an explicit subpath:

```ts
import { runAgentWithStreaming } from '@a2arium/callagent-core/runner';
```

Experimental APIs live under:

```ts
import { /* unstable APIs */ } from '@a2arium/callagent-core/unstable';
```

This package is currently ESM-only. CommonJS support should not be assumed until a real CJS build is published.

## Testing Agents

Use the test harness to assert turns instead of checking only final text.

```ts
import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

const harness = createTestHarness({
  attention,
  perception,
  learning,
  policy,
  shield,
  execution,
  transition,
});

await harness.runTurn();

harness.expectTurn((turn) => {
  turn.expectTransition('complete');
});
```

Scaffolded agents include starter tests. For larger workflows, assert `TurnTrace`, pending tokens, resume observations, tool outputs, and child completions.

## Optional Packages

Install these only when needed:

- `@a2arium/callagent-memory-sql`: PostgreSQL/Prisma-backed memory and session persistence.
- `@a2arium/callagent-chat-bridge`: Telegram, Slack, web chat, or custom chat routing.
- `@a2arium/callagent-eventbus-nats`: NATS JetStream event bus and message log adapters.

## Documentation

- Root overview: ../../README.md
- Release/package strategy: ../../docs/release-strategy.md
- APLRET contracts: ../../apps/docs/0-aplret_contracts.md
- First agent tutorial: ../../apps/docs/1-tutorial_build_your_first_aplret_agent.md
- Testing guide: ../../apps/docs/11-how_to_test_aplret_agents.md
- TurnTrace debugging: ../../apps/docs/12-how_to_debug_with_turn_trace.md
- Multi-agent conversations: ../../apps/docs/15-how_to_multiagent_conversation.md

## License

MIT
