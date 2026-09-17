# Telemetry and Observability

The CallAgent framework uses a **one-TurnTrace-per-turn** telemetry model: each turn emits a single structured **TurnTrace** that includes module timings, inbox snapshot, intent/shield/execution/transition summaries, and optional sub-call arrays (LLM, tool, child). There are **no per-module spans** (no ModuleNode); module timings live inside **TurnTrace.timings**. Sub-spans (LLM, tool, child) are logical children of the **TurnNode** for that turn.

## Key concepts

- **One TurnTrace per turn** — The loop emits exactly one TurnTrace per turn. No more, no fewer. It is the primary unit for debugging and testing.
- **TurnTrace-aware providers** — Providers implement **`onTurnTrace(trace: TurnTrace)`** to receive the full trace once per turn. Optional **`onNodeStart`** / **`onNodeEnd`** are used only for agent-level (and optionally turn/sub-span) boundaries when the provider needs span-style events.
- **Sub-span hierarchy** — LLM calls, tool calls, and child-agent calls are recorded as **TurnTrace.llmCalls**, **TurnTrace.toolCalls**, **TurnTrace.childCalls**. In span-based backends they are represented as children of the TurnNode (e.g. **LLMNode**, **ToolNode**, **ChildCallNode**). Child-agent execution is linked via **ChildCallNode** and optional `parentTurnId` / `childTraceId`.
- **Manifest provenance** — Every TurnTrace carries **agentCardSource**, **runtimeManifestSource**, **agentCardHash**, **runtimeManifestHash**. Provenance is persisted in snapshot meta and restored on resume.

## Configuration

### Console provider (local debugging)

Set:

```bash
export CONSOLE_TELEMETRY=true
# OR
export TELEMETRY_CONSOLE=true
```

The **ConsoleProvider** implements **`onTurnTrace`** and prints a compact summary per turn (turn number, timings, intent/shield/transition summary, optional sub-call counts). It does **not** emit per-module lines; all module timings are inside the single turn summary.

Example output:

```
[Turn 1] turnId=... totalMs=120 attentionMs=2 perceptionMs=1 ... intent=language shield=pass transition=continue
[Turn 2] turnId=... totalMs=80 ...
```

### External telemetry

Callagent no longer ships a built-in external trace exporter. Keep full
prompt/response telemetry in the application layer or in callllm, and keep
callagent focused on compact TurnTrace, operator events, and `/metrics` JSON.
Custom integrations can still be registered manually through the generic
`TelemetryProvider` interface.

## Manual configuration

Use the **telemetry** singleton to add providers. Providers must implement **TelemetryProvider**, including **`onTurnTrace(trace: TurnTrace)`** to receive the per-turn trace.

```ts
import { telemetry, ConsoleProvider, type TelemetryProvider, type TurnTrace } from '@a2arium/callagent-core';

telemetry.addProvider(new ConsoleProvider());

class MyProvider implements TelemetryProvider {
    name = 'custom';
    onTurnTrace(trace: TurnTrace) {
        // One call per turn with full TurnTrace
        console.log('Turn', trace.turn, trace.turnId, trace.timings.totalMs);
    }
    onNodeStart(node) { /* optional: agent/turn/sub-span */ }
    onNodeEnd(node) { /* optional */ }
}
telemetry.addProvider(new MyProvider());
```

## Data model

| Node / type   | Description |
|---------------|-------------|
| **AgentNode** | Full task execution. Root of the trace. |
| **TurnNode**  | One turn. Carries **TurnTrace** (turn, turnId, timings, inboxCurrent, intent, shield, execAction, execResult, transition, pendingAfter, llmCalls, toolCalls, childCalls, error, provenance). |
| **LLMNode**   | One LLM call. Child of TurnNode. |
| **ToolNode**  | One tool call. Child of TurnNode. |
| **ChildCallNode** | One child-agent dispatch/completion. Child of TurnNode; links to child trace via optional childTraceId / childAgentNodeId. |

There is **no ModuleNode**. Module timings are fields in **TurnTrace.timings** (attentionMs, perceptionMs, learningMs, policyMs, shieldMs, executionMs, transitionMs, totalMs).

## Collecting traces in tests

Pass **`collectTraces: true`** (and optionally **`manifestProvenance`**) to **`runLoop`**. The result includes **`result.traces`** (array of **TurnTrace**), one per turn. See **How-to: Test APLRET agents** and **How-to: Debug with TurnTrace**.

## Integration with usage tracking

When **`ctx.recordUsage()`** is called (e.g. from Execution after an LLM call), usage is associated with the turn and appears in **TurnTrace.usage** and in **TurnTrace.llmCalls** (and similarly for tools). Costs and token counts are aggregated at the turn level.

---

TODO: Integration with OpenLIT or other backends as needed.
