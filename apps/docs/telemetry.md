# Telemetry and Observability

The CallAgent framework includes a built-in, hierarchical telemetry system that provides visibility into agent execution, performance, and costs. It supports pluggable providers, allowing you to stream data to different backends (e.g., Console, Opik, OpenTelemetry) with minimal configuration.

## Key Features

- **Zero-Touch Instrumentation**: `TaskEngine` and `TurnRunner` automatically track Agent and Turn execution. You don't need to manually verify start/end calls in your agent code.
- **Hierarchical Tracing**: Events are structured in a tree (Agent -> Turn -> Module -> Tool/LLM), preserving context.
- **Cost & Usage Tracking**: Token usage and costs are aggregated up the tree automatically.
- **Pluggable Providers**: Switch between or combine multiple backends (Console, Opik, etc.).

## 1. Zero-Code Configuration

The easiest way to use telemetry is via environment variables. The framework checks these on startup and automatically configures the appropriate providers.

### Console Provider (Local Debugging)
To see telemetry events in your terminal:

```bash
export CONSOLE_TELEMETRY=true
# OR
export TELEMETRY_CONSOLE=true
```

Output example:
```
[START] AGENT ID=...
[START] TURN ID=...
[END] TURN ID=... Status=success Duration=150ms
[END] AGENT ID=... Status=success Duration=450ms
```

### Opik (Observability Platform)
To stream traces to [Opik](https://www.comet.com/site/products/opik/):

1.  Set the `CALLAGENT_OPIK_ENABLED` flag (or just provide the API key):
    ```bash
    export CALLAGENT_OPIK_ENABLED=true
    ```
2.  Configure standard Opik variables:
    ```bash
    export OPIK_API_KEY="your-api-key"
    export OPIK_WORKSPACE="your-workspace"
    export OPIK_PROJECT_NAME="your-project"
    ```

The framework will automatically mapping:
- **Agents** -> **Traces**
- **Turns**, **Tools**, **LLM Calls** -> **Spans**

## 2. Manual Configuration

If you need more control (e.g., adding custom providers or configuring them programmatically), you can use the `telemetry` singleton.

```typescript
import { telemetry, ConsoleProvider, OpikProvider } from '@a2arium/callagent-core';

// Add providers manually
telemetry.addProvider(new ConsoleProvider());

// You can create your own custom provider by implementing the TelemetryProvider interface
class MyCustomProvider implements TelemetryProvider {
    name = "custom";
    onNodeStart(node) { ... }
    onNodeEnd(node) { ... }
    // ...
}
telemetry.addProvider(new MyCustomProvider());
```

## 3. Data Model

The telemetry system uses a node-based hierarchy:

| Node Type | Description |
| :--- | :--- |
| **AgentNode** | Represents a full task execution. Maps to a **Trace** in distributed tracing systems. |
| **TurnNode** | Represents a single turn loop. Child of AgentNode. |
| **ModuleNode** | (Optional) Represents a module execution within a turn. |
| **ToolNode** | Represents a tool execution. |
| **LLMNode** | Represents an LLM call. |

### Manual Instrumentation

While Agents and Turns are tracked automatically, you can manually track custom units of work (e.g., a complex calculation or sub-routine) using `ToolNode` or generic nodes:

```typescript
import { ToolNode, telemetry } from '@a2arium/callagent-core';

const node = new ToolNode('my-complex-operation', parentNodeId);
telemetry.registerNode(node);
node.start(inputData);

try {
    const result = await performOperation();
    node.end(result);
    telemetry.endNode(node);
} catch (err) {
    node.fail(err);
    telemetry.failNode(node);
}
```

## 4. Integration with Usage Tracking

The Telemetry system integrates with the [Usage Tracking](./usage-tracking.md) system. When `ctx.recordUsage()` is called, the cost and token counts are associated with the active telemetry node and propagated up the hierarchy (e.g., adding to the Turn's total, which adds to the Agent's total).

TODO:
Do integration with https://github.com/openlit/openlit
