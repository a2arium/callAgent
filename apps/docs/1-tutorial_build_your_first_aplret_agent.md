# Tutorial: Build Your First APLRET Agent

This tutorial walks you through a minimal loop-mode agent using the APLRET model.

## What you will build

A simple agent that:

- waits for user input
- stores the validated message in memory
- answers with an LLM
- completes the turn sequence cleanly

## What you will learn

By the end, you will understand the basic shape of:

- Attention
- Perception
- Learning
- Policy
- Shield
- Execution
- Transition

You will also see the most important boundary rules in practice:

- Perception reads only inbox
- Learning is the only writer of memory
- Policy is sync and M-only
- Execution is the only effect boundary
- Default manifest behavior and how to override it

## Step 0: Create the manifests

### 0.1 Agent Card (A2A) — `agent-card.json`

Create `agent-card.json` in your repository root. This declares what the agent can do.

```json
{
  "name": "my-agent",
  "description": "My first callagent APLRET agent",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extensions": [
      {
        "uri": "https://github.com/a2arium/callagent/extensions/callagent/v1",
        "required": false
      }
    ]
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "chat",
      "name": "Chat",
      "description": "Responds to user messages",
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain"]
    }
  ],
  "supportedInterfaces": [
    {
      "protocolBinding": "JSONRPC",
      "protocolVersion": "0.2.5",
      "url": "https://example.com/a2a"
    }
  ]
}
```

The framework will serve this resolved card at `/.well-known/agent-card.json` automatically.

### 0.2 Runtime Manifest — `agent.runtime.json`

Create `agent.runtime.json` in the repo root. This configures the runtime loops, budgets, and TurnTrace behavior.

```json
{
  "name": "my-agent",
  "version": "1.0.0",
  "budgets": { "maxTurns": 10, "latencyMs": 30000 },
  "observability": { "turnTrace": { "enabled": true, "level": "summary" } }
}
```

*Note: Name and version must match the Agent Card.*

## Step 1: Define your minimal observation and intent types

```ts
type Sensory = {
  latestUserText?: string;
};

type Obs =
  | { kind: 'user_message'; text: string }

type Intent =
  | { kind: 'prompt_user'; prompt: string }
  | { kind: 'answer_with_llm'; query: string }
  | { kind: 'wait' };
```

Keep the first version small.

## Step 2: Create the agent shell

By passing no extra configuration to `createAgent`, the framework will load the default manifests (`agent-card.json` and `agent.runtime.json`) automatically.

```ts
import { createAgent } from '@a2arium/callagent-core';

export const agent = createAgent<Sensory, Obs, unknown, Intent, unknown>({
  // Manifests resolve entirely by default if run from repo root.
  // Overrides are possible via agentCard: { path: ... } or { inline: ... }

  attention: (_m, env) => ({
    hasCurrentInput: env.inbox.current.some(o => o.source === 'user')
  }),

  perception: (env) => {
    const userObs = env.inbox.current.find(
      o => o.source === 'user' && o.kind === 'input.provided'
    );

    if (!userObs) return { kind: 'idle' };

    const value = userObs.payload.value;
    const text = typeof value === 'string' ? value : value.text;

    return { kind: 'user_message', text };
  },

  learning: (prev, _prevAction, obs) => {
    if (obs.kind !== 'user_message') return prev;

    return {
      ...prev,
      memory: {
        ...prev.memory,
        sensory: {
          ...(prev.memory?.sensory ?? {}),
          latestUserText: obs.text
        }
      }
    };
  },

  policy: (m) => {
    const text = m.memory?.sensory?.latestUserText;

    if (!text) {
      return { kind: 'prompt_user', prompt: 'Your message' };
    }

    return { kind: 'answer_with_llm', query: text };
  },

  shield: (_m, intent) => ({ action: 'pass', intent }),

  execution: async (intent, ctx) => {
    if (intent.kind === 'prompt_user') {
      const handle = await ctx.requestInput(intent.prompt);

      return {
        action: { kind: 'ask_user', token: handle.token },
        result: {
          status: 'ok',
          data: { promptRequested: true }
        }
      };
    }

    if (intent.kind === 'answer_with_llm') {
      const res = await ctx.llm.call(intent.query);
      const text = res[0]?.content ?? 'Ok.';

      await ctx.reply(text);

      return {
        action: { kind: 'internal', done: true },
        result: {
          status: 'ok',
          data: { replied: true, text }
        }
      };
    }

    return {
      action: { kind: 'internal', done: true },
      result: {
        status: 'ok',
        data: { idle: true }
      }
    };
  },

  transition: (_env, exec) => {
    if (exec.action.kind === 'ask_user') {
      return {
        kind: 'await_input',
        token: exec.action.token
      };
    }

    return {
      kind: 'complete',
      result: { ok: true }
    };
  }
}, import.meta.url);
```

## Step 3: Understand the first turn

When there is no user input yet:

- Attention notices inbox is empty
- Perception returns `idle`
- Learning leaves memory unchanged
- Policy emits `prompt_user`
- Shield passes
- Execution requests input and returns a token
- Transition returns `await_input(token)`

This is the correct first-turn behavior.

## Step 4: Understand the resume turn

When the user replies, the runtime injects:

- `source: 'user'`
- `kind: 'input.provided'`
- `payload.value = the user text`

Then:

- Perception validates and normalizes the message
- Learning writes `latestUserText`
- Policy reads `latestUserText` from memory
- Policy emits `answer_with_llm`
- Execution calls the LLM and replies
- Transition completes

Notice the important rule:

**Policy sees the user input only after it has gone through Perception and Learning.**

## Step 5: Add your first test idea

Even in a tutorial agent, think in turns.

You want at least two tests:

### Test 1: first turn awaits input

Assert:

- `intent.kind === 'prompt_user'`
- `transition.kind === 'await_input'`
- the await token exists

### Test 2: resume turn answers with LLM

Inject `user / input.provided`, then assert:

- Perception sees the user input
- Learning writes memory
- Policy chooses `answer_with_llm`
- Execution replies
- Transition completes

## Step 6: Know what not to do

Avoid these mistakes in your first agent.

### Don’t read `ctx` or `env` in Policy

Policy should stay sync and read only `MentalState`.

### Don’t update memory in Execution

Execution performs effects only.

### Don’t read from `env.inbox.all` in Perception

Perception should read only `env.inbox.current`.

### Don’t put raw large payloads into memory

Use artifact handles later when needed.

## Step 7: Where to go next

Once this minimal agent works, the next guides to read are:

- Manifest Spec: Agent Card + Runtime Manifest
- How-to: Test APLRET agents using TurnTrace
- How-to: Keep Policy pure when the implementation wants to put too much there
- How-to: Child-Agent Await and Resume (APLRET)
- How-to: Use Artifacts Correctly (APLRET)

## What you built

You now have a minimal APLRET agent with the correct boundaries:

- inbox-only Perception
- single-writer Learning
- sync M-only Policy
- effectful Execution
- explicit Transition

That is the correct foundation for adding tools, child agents, and larger memory patterns later.

