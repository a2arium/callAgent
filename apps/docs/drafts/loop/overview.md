## Loop Architecture Overview

This document describes the loop-first execution model (Attention → Perception → Learning → Policy → Shield → Execution → Transition) with auto-resume capabilities and how it integrates with MentalState persistence and TaskEngine.

- MentalState `snapshot.M` is the single source of truth, persisted at turn boundaries and before await exits.
- LoopRunner runs one turn per invocation; auto-resume triggers additional turns after events.
- Modules are declared per-agent in `createAgent({ loop: { modules: {...} } })`.
- Auto-resume eliminates the need for explicit durable handlers by appending all event payloads (user input, tool results, child completions) to `env.inbox.current` as observations.

### EnvironmentState with Auto-Resume
```ts
type EnvironmentState = {
  time: string;
  inbox: {
    current: Observation[];   // events for this turn
    all: Observation[];       // historical log
  };
  pending: { inputs: Record<string, unknown>; children: Record<string, unknown>; tools: Record<string, unknown>; groups: Record<string, unknown> };
  lastExec?: unknown;
  externalEvents?: unknown[];
};
```

### Declaring Loop Modules
Agents declare their modules directly in `createAgent` using the `loop.modules` property:
```ts
export default createAgent({
  manifest: { name: 'my-agent', runMode: 'loop' },
  loop: {
    modules: {
      policy: (M, env) => {
        // Handle auto-resumed events via inbox
        const latestInput = env.inbox.current.find(o => o.source === 'user');
        const value = (latestInput?.payload as { value?: string })?.value;
        if (typeof value === 'string') {
          return { kind: 'language', content: `Received: ${value}` };
        }
        return { kind: 'ask_user', prompt: 'What should I do?' };
      }
    }
  },
  async handleTask(ctx) { return; }
}, import.meta.url);
```

#### Delegating to core defaults
When overriding, you can delegate back to the core implementation via `ctx.defaults`:
```ts
loop: {
  modules: {
    execution: async (a, ctx, M) => {
      if (a.kind === 'language') {
        // Augment message and delegate to the default execution
        const augmented = { ...a, content: a.content + ' (via override)' };
        await ctx.reply(augmented.content);
        return { kind: 'language', echoed: true };
      }
      return ctx.defaults.execution(a, ctx, M);
    }
  }
}
```

### Auto-Resume Flow
When agents produce `await_*` outcomes, the engine automatically resumes after events:

1. **Agent produces await outcome**: `{ kind: 'await_input', token: 'abc123' }`
2. **Engine persists MentalState** and exits with `input-required` status
3. **Event occurs**: User provides input via `/tasks/{taskId}/input`
4. **Engine auto-resumes**: Pushes `{ source: 'user', kind: 'input.provided', payload: { token: 'abc123', value: 'user response' } }` onto `env.inbox`
5. **Loop processes event**: Policy module reads `env.inbox.current` and continues

### Example agent with auto-resume
- Example path: `apps/examples/loop-agent-mini/AgentModule.ts`
- Demonstrates:
  - Policy handling user observations from `env.inbox.current` to process resumed events
  - Transition returning `await_input` for user interactions
  - Execution calling `ctx.requestInput()` without `onProvided` handlers

### Transition with auto-resume handling
Standard transition patterns for auto-resume:
```ts
loop: {
  modules: {
    transition: (env, exec, M) => {
      // Auto-resume outcomes
      if (exec.kind === 'ask_user') {
        return { kind: 'await_input', token: exec.token };
      }
      if (exec.kind === 'tool' && exec.token) {
        return { kind: 'await_tool', token: exec.token };
      }
      if (exec.kind === 'subagent' && exec.token) {
        return { kind: 'await_child', token: exec.token };
      }
      
      // Terminal outcomes
      if (exec.kind === 'language') return { kind: 'complete' };
      
      return { kind: 'continue' };
    }
  }
}
```
Note: The engine maps `await_*` tokens into `status.metadata.token` (buffered mode). Extra fields (e.g., `category`, `hint`) are suitable for logs/metrics today, and can be emitted to metadata in a future enhancement.

### Await Outcomes and Status
- `await_input` → status: `input-required` with `metadata.token`
- `await_child`/`await_tool` → status: `working` with `metadata.awaiting` and `metadata.token`

### Budgets
- `latencyMs`: if a turn exceeds this wall-clock time, loop returns `{ kind: 'fail', reason: 'budget_latency_exceeded' }`.
- `maxTurns`: limits turns per invocation; if no terminal/await outcome is reached by the last turn, loop returns `{ kind: 'fail', reason: 'budget_turns_exceeded' }`.
Buffered mode includes `timings` in `status.metadata` for basic per-module latency.

### Snapshot hygiene
- To keep `snapshot.M` bounded:
  - Episodic: keep last N (default 256) and drop events older than TTL (default 30 days)
  - Thoughts: keep last 64
  - Decisions: keep last 100 entries
- Hygiene runs before persistence at the end of a turn.

### Rewards (pluggable)
- Framework exposes two hooks you can override per agent:
  - `extrinsicReward(M, action, exec, outcome) -> number`
  - `intrinsicReward(M, observation) -> number`
- Defaults return 0. The loop aggregates `rewards` per turn and exposes them in `status.metadata.rewards`.
- Example override:
```ts
setModuleOverrides(ctx.agentId, {
  extrinsicReward: (M, a, exec, out) => (out.kind === 'complete' ? 1 : 0),
  intrinsicReward: (M, obs) => 0
});
```

### Policy (policyParams)
- The Policy module may return either a single `ProposedAction` or a distribution `[{ action, prob }]`.
- When a distribution is returned, sampling behavior is controlled by `M.policyParams`:
  - `stochastic: boolean` (default true):
    - true → draw from the (temperature-adjusted) probability distribution with epsilon-greedy exploration
    - false → choose argmax of (temperature-adjusted) probabilities unless epsilon triggers exploration
  - `temperature?: number` (default 1): rescales provided probabilities as `p^(1/temperature)` for softer/harder sampling
  - `explorationEpsilon?: number` (default 0): with probability epsilon, select a random action (uniform)

Example (inside an override):
```ts
setModuleOverrides(ctx.agentId, {
  policy: (M) => ([
    { action: { kind: 'language', content: 'A' }, prob: 0.8 },
    { action: { kind: 'language', content: 'B' }, prob: 0.2 }
  ])
});
// elsewhere (e.g., prior to loop), configure sampling behavior
M.policyParams = { stochastic: true, temperature: 0.7, explorationEpsilon: 0.05 };
```
#### Default budgets per agent
Add default budgets in the manifest and they will be used by the loop driver:
```json
{
  "name": "my-agent",
  "version": "1.0.0",
  "runMode": "loop",
  "budgets": { "maxTurns": 1, "latencyMs": 1500 }
}
```

### Metrics
- Per-turn arrays in buffered status:
  - `metadata.timings`: module latencies per turn (e.g., attentionMs, perceptionMs, ...).
  - `metadata.rewards`: per-turn total rewards from hooks.
- Aggregates for convenience:
  - `metadata.timingsAgg`: `{ moduleName: { sum, avg } }`.
  - `metadata.rewardsAgg`: `{ sum, avg }`.
Use arrays for detailed analysis and aggregates for quick dashboards.

### HITL levels (manifest)
- Configure `hitl` in the manifest: `'advise' | 'consent' | 'guardrails'`.
  - advise: allow actions; intended for monitoring/logging only
  - consent: prompt before tools
  - guardrails: prompt before tools and subagents
- Defaults pass-through; prompts are implemented by Shield as ask_user decisions.
- In advise mode, Shield tags `M.lastAdvise` for observability; in consent/guardrails, prompts include action metadata in schema.

### Offline learning (episodic replay)
- Run an offline optimizer over episodic traces to update policy/reward parameters.
- API:
```ts
import { runOfflineReplay } from '@a2arium/callagent-core/dist/loop/offline.js';
const { M: updated, applied } = await runOfflineReplay(M, {
  onEpisode: (events, M) => ({ policyParamsPatch: { temperature: 0.8 } })
});
```
- Optimizers can patch `M.policyParams` and/or `M.rewardParams`. Results are persisted on the next save.

### Interrupts (await and resume)
- When the loop selects an action that requires waiting (`ask_user` / child / tool), it exits the turn with an `await_*` outcome.
- The engine persists `snapshot.M`, stores a durable token in the appropriate pending map (inputs/tasks/tools), and emits an outbox/status event.
- On external response:
  - `resumeInput({ tenantId, taskId, token, input })` (or child/tool completion) loads the snapshot, validates the token, applies the result, and invokes the registered durable handler.
  - The durable handler continues work (can re-enter the loop). No in-memory state is required; everything is restored from DB.
- This preserves turn-boundary semantics and aligns with the existing await-input logic.

#### External events (non-input)
- You can register arbitrary external events to be delivered at a later time using `ctx.registerExternalEvent(type, data, { onOccurred })`.
- This stores a durable token under `pending.events` and persists `M`, similar to input/tools.
- When the event occurs, the system should call the appropriate handler (e.g., via an API that validates the token) which:
  - loads the snapshot, removes the token, appends an event, and invokes the durable handler specified in `onOccurred`.
- This uses the same DB-backed resume model as inputs/tools and executes at turn boundaries.

To acknowledge externally:
```ts
// server-side
await taskEngine.handleExternalEventOccurred({ tenantId, taskId, token, payload });
```


