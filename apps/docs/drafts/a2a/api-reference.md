# A2A API Reference

> Status: design draft.
> API shapes here may evolve; verify stable contracts in `apps/docs/0-aplret_contracts.md`.

## Core Interfaces

### TaskContext.sendTaskToAgent

The primary method for invoking other agents from within an agent.

```typescript
sendTaskToAgent(
  targetAgent: string,
  input: unknown,
  options?: A2AOptions
): Promise<unknown>
```

#### Parameters

- **targetAgent** (`string`): Name of the target agent to invoke
- **input** (`unknown`): Data to pass to the target agent
- **options** (`A2AOptions`, optional): Configuration for the A2A call

#### Returns

`Promise<unknown>` - The result returned by the target agent

#### Example (non-blocking with handlers)

```typescript
const result = await ctx.sendTaskToAgent('data-processor', {
  data: [1, 2, 3, 4, 5],
  operation: 'analyze'
}, {
  inheritWorkingMemory: true,
  inheritMemory: false
});
```

### A2AOptions

Configuration options for agent-to-agent communication.

```typescript
type A2AOptions = {
  awaitCompletion?: boolean;
  streaming?: boolean;
  onCompleted?: string;
  onFailed?: string;
  onInputRequired?: string;
  setToken?: boolean;
  tokenPath?: string;
  autoClearToken?: boolean;
  setStage?: string;
  inheritWorkingMemory?: boolean;
  inheritMemory?: boolean;
  tenantId?: string;
}
```

#### Properties

- **awaitCompletion** (`boolean`, optional): When `true`, `sendTaskToAgent` resolves with the child's final result and cleans up immediately. When `false`, the call returns a `TaskHandle` with a public `token` getter, and the child completion arrives on the next turn via `env.inbox.current` (even if served from cache). Default: `true` if you do not register `onCompleted`.
- **streaming** (`boolean`, optional): Forward child streaming progress back to the parent task stream.
- **onCompleted / onFailed / onInputRequired** (`string`, optional): Durable handler names fired when the child finishes, fails, or requests more input. Supplying `onCompleted` implicitly sets `awaitCompletion=false`.
- **setToken** (`boolean`, optional): Automatically persist the child token to working memory. Default: `true`.
- **tokenPath** (`string`, optional): Path inside `pending.controlVars` where the token is stored when `setToken` is enabled. Default: `child.token`.
- **autoClearToken** (`boolean`, optional): Remove the stored token once the child completes. Default: `true`.
- **setStage** (`string`, optional): Convenience helper to set the parent's stage immediately after dispatch (e.g., `'awaiting_child'`).
- **inheritWorkingMemory** (`boolean`, optional): Whether to transfer working memory (goals, thoughts, decisions, variables) to the target agent. Default: `false`.
- **inheritMemory** (`boolean`, optional): Whether to transfer long-term memory (semantic, episodic) to the target agent. Default: `false`.
- **tenantId** (`string`, optional): Override the tenant ID for the target agent. Default: uses source agent's tenant.

> **Token defaults**: With no overrides, the engine writes the generated token to `pending.controlVars.child.token` and clears it automatically after the child delivers a terminal observation. Provide your own `tokenPath` (or `setToken:false`) if you need bespoke control-state layout. You can always access the token directly from `handle.token` and `env.pending.children`.

### TaskHandle

When `awaitCompletion: false`, `sendTaskToAgent` returns a `TaskHandle` object.

```typescript
class TaskHandle {
  readonly token: string;  // Public getter for the child token
  
  async run(opts?: { awaitCompletion?: boolean; streaming?: boolean }): Promise<unknown | void>;
  async onCompleted(handlerName: string): Promise<this>;
  async onFailed(handlerName: string): Promise<this>;
  async onInputRequired(handlerName: string): Promise<this>;
}
```

#### Properties

- **token** (`string`, readonly): The unique token identifying this child task. Use this in transition logic to return `{ kind: 'await_child', token: handle.token }`.

#### Example Usage

```typescript
// In execution module
const handle = await ctx.sendTaskToAgent('fetch-webpage', { url }, {
    awaitCompletion: false,
    tokenPath: 'fetch.token',
    setStage: 'awaiting_fetch'
});

return {
    action: { kind: 'internal', done: true },
    result: {
        status: 'ok',
        data: {
            awaitingFetch: true,
            token: handle.token  // ✅ Access token via public getter
        }
    }
};

// In transition module
transition: (env, exec, m, mem) => {
    if (exec.result.data?.awaitingFetch && exec.result.data?.token) {
        return {
            kind: 'await_child',
            token: exec.result.data.token
        };
    }
    // ...
}
```

## A2A Service

### A2AService Class

The core service that handles agent-to-agent communication.

```typescript
class A2AService {
  async sendTaskToAgent(
    sourceCtx: MinimalSourceTaskContext,
    targetAgent: string,
    input: unknown,
    options?: A2AOptions
  ): Promise<unknown>
}
```

#### Methods

##### sendTaskToAgent

Executes an agent-to-agent communication.

**Parameters:**
- `sourceCtx`: The source agent's context
- `targetAgent`: Name of the target agent
- `input`: Input data for the target agent
- `options`: A2A configuration options

**Returns:** Promise resolving to the target agent's result

**Throws:**
- `Error` if target agent is not found
- `Error` if context serialization fails
- Re-throws any error from target agent execution

## TaskContext.reply

Emits user-facing output as Artifacts on the task stream. In parent→child A2A, child replies are mirrored to the parent task stream with the child agent name prefix.

```typescript
await ctx.reply('Starting analysis...');
await ctx.reply([{ type: 'text', text: 'Final summary' }]);
```

Notes:
- Replies are not delivered to parent handler parameters.
- For parent consumption, return a value from the handler; it will be delivered as the blocking call result or to `onCompleted`.

## Context Serialization

### ContextSerializer Class

Handles serialization and deserialization of agent context.

```typescript
class ContextSerializer {
  async serializeContext(
    sourceCtx: MinimalSourceTaskContext,
    options: A2AOptions
  ): Promise<SerializedContext>

  async deserializeContext(
    serializedContext: SerializedContext,
    targetCtx: TaskContext
  ): Promise<void>
}
```

#### Methods

##### serializeContext

Serializes source agent context for transfer.

**Parameters:**
- `sourceCtx`: Source agent's context
- `options`: Serialization options

**Returns:** Promise resolving to serialized context

##### deserializeContext

Deserializes context into target agent.

**Parameters:**
- `serializedContext`: Previously serialized context
- `targetCtx`: Target agent's context

**Returns:** Promise that resolves when deserialization is complete

### SerializedContext

The structure used to transfer context between agents.

```typescript
type SerializedContext = {
  workingMemory?: SerializedWorkingMemory;
  memoryContext?: SerializedMemoryContext;
  tenantId: string;
  sourceAgentId: string;
  timestamp: string;
}
```

#### Properties

- **workingMemory** (`SerializedWorkingMemory`, optional): Serialized working memory state
- **memoryContext** (`SerializedMemoryContext`, optional): Serialized long-term memory
- **tenantId** (`string`): Tenant identifier
- **sourceAgentId** (`string`): ID of the source agent
- **timestamp** (`string`): ISO timestamp of serialization

### SerializedWorkingMemory

Working memory state that can be transferred between agents.

```typescript
type SerializedWorkingMemory = {
  goal?: string;
  thoughts: Array<{ content: string; timestamp: string }>;
  decisions: Array<{
    key: string;
    decision: string;
    reasoning?: string;
    timestamp: string;
  }>;
  variables: Record<string, unknown>;
}
```

#### Properties

- **goal** (`string`, optional): Current goal of the source agent
- **thoughts** (`Array`): List of thoughts with timestamps
- **decisions** (`Array`): List of decisions made by the source agent
- **variables** (`Record<string, unknown>`): Working variables

### SerializedMemoryContext

Long-term memory context for transfer.

```typescript
type SerializedMemoryContext = {
  memorySnapshot: RecalledMemoryItem[];
}
```

#### Properties

- **memorySnapshot** (`RecalledMemoryItem[]`): Array of recalled memory items

### RecalledMemoryItem

Individual memory item structure.

```typescript
type RecalledMemoryItem = {
  id: string;
  type: 'semantic' | 'episodic' | string;
  data: unknown;
  metadata?: Record<string, unknown>;
}
```

#### Properties

- **id** (`string`): Unique identifier for the memory item
- **type** (`string`): Type of memory (semantic, episodic, etc.)
- **data** (`unknown`): The actual memory data
- **metadata** (`Record<string, unknown>`, optional): Additional metadata

## Agent Registry

### AgentRegistry Class

Manages agent discovery and registration.

```typescript
class AgentRegistry {
  registerAgent(agent: Agent): void
  findAgent(name: string): Agent | undefined
  listAgents(): AgentManifest[]
  clear(): void
}
```

#### Methods

##### registerAgent

Registers an agent for discovery.

**Parameters:**
- `agent`: The agent instance to register

##### findAgent

Finds an agent by name.

**Parameters:**
- `name`: Agent name to search for

**Returns:** Agent instance or `undefined` if not found

##### listAgents

Lists all registered agents.

**Returns:** Array of agent manifests

##### clear

Clears all registered agents (primarily for testing).

### PluginManager

Static utility for agent management.

```typescript
class PluginManager {
  static registerAgent(agent: Agent): void
  static findAgent(name: string): Agent | undefined
  static listAgents(): AgentManifest[]
}
```

#### Static Methods

##### registerAgent

Registers an agent globally.

**Parameters:**
- `agent`: Agent instance to register

##### findAgent

Finds a registered agent by name.

**Parameters:**
- `name`: Agent name

**Returns:** Agent instance or `undefined`

##### listAgents

Lists all registered agents.

**Returns:** Array of agent manifests

## Type Definitions

### MinimalSourceTaskContext

Minimal context interface required for A2A source agents.

```typescript
type MinimalSourceTaskContext = {
  task: Task;
  tenantId: string;
  agentId: string;
  getGoal?: () => Promise<string | undefined>;
  getThoughts?: () => Promise<Array<{ content: string; timestamp: string }> | undefined>;
  memory: MemoryService;
  vars?: Record<string, unknown>;
  llm: LLMService;
  tools: ToolService;
  recall?: (query: string, options?: RecallOptions) => Promise<RecalledMemoryItem[]>;
}
```

### Agent

Agent interface for registration and execution.

```typescript
type Agent = {
  manifest: AgentManifest;
  handleTask: (ctx: TaskContext) => Promise<unknown>;
}
```

### AgentManifest

Agent manifests describe how callAgent discovers, initializes, and governs individual agents. You can define the manifest inline (via `createAgent({ manifest })`) or in a JSON file next to the agent entrypoint. When a folder contains multiple agents, only the primary agent may ship a JSON manifest; supporting agents use inline manifests.

#### Naming and versioning rules
- `name` must be lowercase and use `-` as the separator (`research-orchestrator`, not `ResearchOrchestrator`). For folder-based discovery, the main agent name must match the folder name exactly.
- `version` follows semantic versioning so orchestrators can reason about compatibility.

#### Core metadata
- `description` communicates agent purpose in registries and tooling.
- `runMode` determines whether the loop runtime (`'loop'`, default) or legacy runner powers execution.
- `budgets.maxTurns` / `budgets.latencyMs` provide default loop limits that runners enforce unless overridden per task.
- `hitl` selects the human-in-the-loop posture (`'advise' | 'consent' | 'guardrails'`).
- `safety` enables sanitization, cost ceilings, and PII detection patterns without custom guards.

#### Dependencies and memory profile
- `dependencies.agents` lists other agents this agent can invoke; entries must reference registered agent names (same lowercase-with-dashes convention).
- `memory.profile` selects one of the predefined Memory Lifecycle Orchestrator profiles (for example `basic` or `mlo-latency-optimized`) and may include additional per-profile settings. All memory inheritance flows through the MLO pipeline.

#### A2A defaults
- `a2a.maxConcurrentCalls` caps fan-out.
- `a2a.defaultTimeout` establishes a default timeout for downstream A2A calls.
- `a2a.allowedTargets` limits which agents may be contacted (use `['*']` to allow all).
- `a2a.memoryInheritance` supplies default working/semantic/episodic inheritance flags if callers omit options.

#### Result caching and extensibility
- `cache.enabled` toggles agent result caching. When enabled, matching inputs short-circuit the handler and reuse the cached payload while marking provenance.
- `cache.ttlSeconds` sets the time-to-live (default 300 seconds if omitted).
- `cache.excludePaths` prevents dynamic fields (for example `requestId`) from contributing to the cache key.
- Additional keys are permitted so packages can extend the manifest without breaking existing tooling. Runners ignore unknown settings but propagate them to child agents.

#### Full type definition

```typescript
type AgentManifest = {
  name: string;
  version: string;
  description?: string;
  runMode?: 'loop' | 'legacy';
  budgets?: {
    maxTurns?: number;
    latencyMs?: number;
  };
  hitl?: 'advise' | 'consent' | 'guardrails';
  safety?: {
    sanitize?: boolean;
    costLimit?: number;
    piiPatterns?: string[];
  };
  dependencies?: {
    agents?: string[];
  };
  memory?: {
    profile?: string;
    [key: string]: unknown;
  };
  a2a?: {
    maxConcurrentCalls?: number;
    defaultTimeout?: number;
    allowedTargets?: string[];
    memoryInheritance?: {
      working?: boolean;
      semantic?: boolean;
      episodic?: boolean;
    };
  };
  cache?: {
    enabled?: boolean;
    ttlSeconds?: number;
    excludePaths?: string[];
  };
  [key: string]: unknown;
}
```

## Error Types

### A2AError

Base error type for A2A operations.

```typescript
class A2AError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'A2AError';
  }
}
```

### Common Error Codes

- **AGENT_NOT_FOUND**: Target agent is not registered
- **SERIALIZATION_FAILED**: Context serialization failed
- **DESERIALIZATION_FAILED**: Context deserialization failed
- **EXECUTION_FAILED**: Target agent execution failed
- **TENANT_MISMATCH**: Cross-tenant communication attempted

## Usage Examples

### Basic Agent Call (blocking)

```typescript
export default createAgent({
  manifest: { name: 'caller', version: '1.0.0' },
  
  async handleTask(ctx) {
    const result = await ctx.sendTaskToAgent('target', { data: 'test' });
    return result;
  }
}, import.meta.url);
```

### With Working Memory Inheritance

```typescript
export default createAgent({
  manifest: { name: 'parent', version: '1.0.0' },
  
  async handleTask(ctx) {
    await ctx.goals?.add?.({ title: 'Process data' });
    ctx.vars!.priority = 'high';
    
    const result = await ctx.sendTaskToAgent('child', { data: 'test' }, {
      inheritWorkingMemory: true
    });
    
    return result;
  }
}, import.meta.url);
```

### With Full Context Transfer

```typescript
export default createAgent({
  manifest: { name: 'coordinator', version: '1.0.0' },
  
  async handleTask(ctx) {
    await ctx.remember?.('context', { key: 'value' });
    
    const result = await ctx.sendTaskToAgent('specialist', { task: 'analyze' }, {
      inheritWorkingMemory: true,
      inheritMemory: true
    });
    
    return result;
  }
}, import.meta.url);
```

### Error Handling

```typescript
export default createAgent({
  manifest: { name: 'resilient', version: '1.0.0' },
  
  async handleTask(ctx) {
    try {
      const result = await ctx.sendTaskToAgent('target', { data: 'test' });
      return result;
    } catch (error) {
      if (error.message.includes('not found')) {
        // Handle agent not found
        return { error: 'Agent unavailable' };
      }
      throw error; // Re-throw other errors
    }
  }
}, import.meta.url);
```

## Integration Notes

### Memory System Integration

A2A communication integrates with the MLO (Memory Lifecycle Orchestrator) pipeline:

1. **Acquisition**: Context is filtered and validated
2. **Encoding**: Memory is processed for transfer
3. **Derivation**: Insights are extracted
4. **Retrieval**: Relevant context is identified
5. **Neural Memory**: Patterns are preserved
6. **Utilization**: Context is optimized for target

### Tenant Isolation

All A2A operations respect tenant boundaries:
- Source and target agents must be in the same tenant
- Memory context is filtered by tenant
- Cross-tenant communication is prevented

### Performance Considerations

- Agent discovery: ~1-5ms
- Context serialization: ~10-50ms
- Memory transfer: ~20-100ms
- Total overhead: ~50-200ms

Optimize by:
- Using selective memory inheritance
- Minimizing context size
- Caching agent references 

## TaskContext.sendTaskToAgent()

Send a task to another agent with optional context inheritance.

### Signature

```typescript
sendTaskToAgent(
  targetAgent: string,
  taskInput: TaskInput,
  options?: A2ACallOptions
): Promise<InteractiveTaskResult | unknown>
```

### Parameters

#### `targetAgent: string`
The name or identifier of the target agent to invoke.

- **Type**: `string`
- **Required**: Yes
- **Examples**: 
  - `'data-analysis-agent'`
  - `'report-generator'`
  - `'customer-service'`

#### `taskInput: TaskInput`
Input data to pass to the target agent.

- **Type**: `TaskInput` (any serializable object)
- **Required**: Yes
- **Examples**:
```typescript
// Simple input
{ message: "Process this data" }

// Complex input
{
  dataSource: "quarterly-reports",
  filters: { year: 2024, quarter: "Q4" },
  outputFormat: "json"
}
```

#### `options?: A2ACallOptions`
Configuration options for the agent call.

- **Type**: `A2ACallOptions`
- **Required**: No
- **Default**: `{}`

### A2ACallOptions

```typescript
type A2ACallOptions = {
  inheritMemory?: boolean;
  inheritWorkingMemory?: boolean;
  tenantId?: string;
  timeout?: number;
  streaming?: boolean;
};
```

#### `inheritMemory?: boolean`
Whether to transfer semantic and episodic memory context.

- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, relevant semantic and episodic memory is transferred to the target agent
- **Performance Impact**: +20-100ms depending on memory size

#### `inheritWorkingMemory?: boolean`
Whether to transfer working memory state (goals, thoughts, decisions, variables).

- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, complete working memory context is transferred
- **Performance Impact**: +10-50ms

#### `tenantId?: string`
Override the tenant context for the target agent.

- **Type**: `string`
- **Default**: Current agent's tenant ID
- **Description**: Allows cross-tenant communication (if permitted)
- **Security**: Must comply with tenant isolation policies

#### `timeout?: number`
Maximum time to wait for agent completion (milliseconds).

- **Type**: `number`
- **Default**: No timeout (future: 30000ms)
- **Description**: Agent call will be cancelled if it exceeds this time
- **Range**: 1000ms - 300000ms (5 minutes max)

#### `streaming?: boolean`
Enable streaming updates from the target agent.

- **Type**: `boolean`
- **Default**: `false`
- **Description**: **Future feature** - receive real-time updates
- **Returns**: `InteractiveTaskResult` when enabled

### Return Types

#### Blocking Execution (default)
When you omit `onCompleted`, the call awaits child completion and returns the result.

```typescript
const result = await ctx.sendTaskToAgent('calculator', { 
  operation: 'add', 
  numbers: [1, 2, 3] 
});
// result: { sum: 6 }
```

#### Interactive/Streaming Execution (future)
Returns an `InteractiveTaskResult` for real-time communication.

```typescript
const task = await ctx.sendTaskToAgent('long-running-task', input, {
  streaming: true
});

task.onStatusUpdate((status) => {
  console.log('Status:', status.state);
});

const finalResult = await task.waitForCompletion();
```

### InteractiveTaskResult

Interface for managing streaming/interactive agent communication.

```typescript
interface InteractiveTaskResult {
  onStatusUpdate: (callback: (status: TaskStatus) => void) => void;
  onArtifactUpdate: (callback: (artifact: Artifact) => void) => void;
  onInputRequired: (callback: (prompt: string) => Promise<string>) => void;
  sendInput: (input: string) => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  waitForCompletion: () => Promise<unknown>;
  getStatus: () => Promise<TaskStatus>;
}
```

#### Methods

##### `onStatusUpdate(callback)`
Subscribe to status change events.

```typescript
task.onStatusUpdate((status: TaskStatus) => {
  console.log(`Task ${status.state}: ${status.message}`);
});
```

##### `onArtifactUpdate(callback)`
Subscribe to artifact/output events.

```typescript
task.onArtifactUpdate((artifact: Artifact) => {
  console.log('New artifact:', artifact.name);
});
```

##### `onInputRequired(callback)`
Handle input-required scenarios.

```typescript
// Use options-based handlers when dispatching instead
await ctx.sendTaskToAgent('agent', input, {
  onInputRequired: 'onAgentNeedsInput'
});
```

##### `sendInput(input)`
Send input to continue task execution.

```typescript
await task.sendInput("User's response to the question");
```

##### `cancel(reason?)`
Cancel the running task.

```typescript
await task.cancel("User requested cancellation");
```

##### `waitForCompletion()`
Wait for task completion and get final result.

```typescript
const finalResult = await task.waitForCompletion();
```

##### `getStatus()`
Get current task status.

```typescript
const status = await task.getStatus();
console.log(status.state); // 'submitted' | 'working' | 'completed' | etc.
```

## Error Handling

### Common Errors

#### AgentNotFoundError
Thrown when the target agent cannot be located.

```typescript
try {
  await ctx.sendTaskToAgent('non-existent-agent', input);
} catch (error) {
  if (error.message.includes('not found')) {
    // Handle missing agent
  }
}
```

#### TimeoutError (future)
Thrown when agent execution exceeds the specified timeout.

```typescript
try {
  await ctx.sendTaskToAgent('slow-agent', input, { timeout: 5000 });
} catch (error) {
  if (error.name === 'TimeoutError') {
    // Handle timeout
  }
}
```

#### ContextSerializationError
Thrown when context cannot be serialized for transfer.

```typescript
try {
  await ctx.sendTaskToAgent('target', input, { inheritWorkingMemory: true });
} catch (error) {
  if (error.message.includes('serialization')) {
    // Handle context issues
  }
}
```

#### TenantIsolationError
Thrown when cross-tenant communication is not permitted.

```typescript
try {
  await ctx.sendTaskToAgent('target', input, { tenantId: 'other-tenant' });
} catch (error) {
  if (error.message.includes('tenant')) {
    // Handle isolation violation
  }
}
```

## Agent Registry API

### PluginManager.findAgent()

Find a registered agent by name.

```typescript
import { PluginManager } from '@a2arium/core';

const agent = PluginManager.findAgent('data-analyzer');
if (agent) {
  console.log('Found:', agent.resolved.agentCard.name);
}
```

### PluginManager.listAgents()

List all registered agents.

```typescript
const agents = PluginManager.listAgents();
agents.forEach(agent => {
  console.log(`${agent.name} v${agent.version}`);
});
```
