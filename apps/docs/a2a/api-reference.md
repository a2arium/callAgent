# A2A API Reference

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

#### Example

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
  inheritWorkingMemory?: boolean;
  inheritMemory?: boolean;
  tenantId?: string;
}
```

#### Properties

- **inheritWorkingMemory** (`boolean`, optional): Whether to transfer working memory (goals, thoughts, decisions, variables) to the target agent. Default: `false`
- **inheritMemory** (`boolean`, optional): Whether to transfer long-term memory (semantic, episodic) to the target agent. Default: `false`
- **tenantId** (`string`, optional): Override the tenant ID for the target agent. Default: uses source agent's tenant

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

Agent metadata and configuration.

```typescript
type AgentManifest = {
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  memory?: {
    profile?: string;
  };
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

### Basic Agent Call

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
    await ctx.setGoal?.('Process data');
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

#### Synchronous Execution (default)
Returns the direct result from the target agent's `handleTask()` method.

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
task.onInputRequired(async (prompt: string) => {
  const response = await getUserInput(prompt);
  return response;
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
import { PluginManager } from '@callagent/core';

const agent = PluginManager.findAgent('data-analyzer');
if (agent) {
  console.log('Found:', agent.manifest.name);
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

### PluginManager.registerAgent()

Register a new agent (typically done automatically).

```typescript
import { createAgent } from '@callagent/core';

const myAgent = createAgent({
  manifest: { name: 'my-agent', version: '1.0.0' },
  async handleTask(ctx) { /* ... */ }
}, import.meta.url);

PluginManager.registerAgent(myAgent);
```

## Memory Context APIs

### Working Memory Transfer

When `inheritWorkingMemory: true`, the following context is transferred:

#### Goals
```typescript
// Source agent
await ctx.setGoal('Analyze customer data');

// Target agent receives
const goal = await ctx.getGoal(); // 'Analyze customer data'
```

#### Thoughts
```typescript
// Source agent
await ctx.addThought('Starting analysis');
await ctx.addThought('Data validation complete');

// Target agent receives
const thoughts = await ctx.getThoughts();
// [{ content: 'Starting analysis', ... }, { content: 'Data validation complete', ... }]
```

#### Decisions
```typescript
// Source agent
await ctx.makeDecision('approach', 'comprehensive', 'Full analysis needed');

// Target agent receives
const decision = await ctx.getDecision('approach');
// { decision: 'comprehensive', reasoning: 'Full analysis needed', ... }
```

#### Variables
```typescript
// Source agent
ctx.vars!.customerId = '12345';
ctx.vars!.priority = 'high';

// Target agent receives
console.log(ctx.vars!.customerId); // '12345'
console.log(ctx.vars!.priority);   // 'high'
```

### Long-Term Memory Transfer

When `inheritMemory: true`, relevant memory context is transferred through the MLO pipeline.

#### Semantic Memory
Recent and relevant semantic memory entries are included.

#### Episodic Memory
Recent events and interactions are included for context.

## Configuration

### Agent Manifest Configuration

Agents can specify A2A-related configuration in their manifest:

```typescript
export default createAgent({
  manifest: {
    name: 'my-agent',
    version: '1.0.0',
    a2a: {
      maxConcurrentCalls: 5,        // Future: limit concurrent A2A calls
      defaultTimeout: 30000,        // Future: default timeout
      allowedTargets: ['*'],        // Future: restrict callable agents
      memoryInheritance: {          // Future: default inheritance options
        working: true,
        semantic: false,
        episodic: false
      }
    }
  },
  async handleTask(ctx) { /* ... */ }
}, import.meta.url);
```

### Environment Configuration

```bash
# Future: A2A-specific configuration
A2A_DEFAULT_TIMEOUT=30000
A2A_MAX_CONTEXT_SIZE=1048576
A2A_ENABLE_METRICS=true
```

## Performance Metrics

### Timing Breakdown

Typical A2A call performance:

1. **Agent Discovery**: 1-5ms
2. **Context Serialization**: 10-50ms
3. **Context Transfer**: 5-20ms
4. **Agent Execution**: Variable (depends on agent)
5. **Response Processing**: 5-15ms

**Total Overhead**: 20-90ms + agent execution time

### Memory Usage

Context transfer memory usage:

- **Working Memory**: ~1-10KB per agent
- **Semantic Memory**: ~5-50KB (depends on relevance)
- **Episodic Memory**: ~2-20KB (recent events)

### Optimization Tips

1. **Selective Inheritance**: Only inherit needed context
2. **Agent Caching**: Keep frequently used agents warm
3. **Memory Pruning**: Limit transferred context size
4. **Parallel Execution**: Use `Promise.all()` for independent calls

## Version Compatibility

### Current Version: 1.0.0

- ✅ Local agent communication
- ✅ Working memory inheritance
- ✅ Semantic memory inheritance
- ✅ Basic error handling
- ✅ Agent discovery and registry

### Planned Features

#### Version 1.1.0
- 🔄 Interactive/streaming communication
- 🔄 Timeout management
- 🔄 Enhanced error types

#### Version 1.2.0
- 🔄 External HTTP A2A communication
- 🔄 A2A protocol compliance
- 🔄 Agent discovery via HTTP

#### Version 2.0.0
- 🔄 Advanced workflow orchestration
- 🔄 Resource management
- 🔄 Performance optimizations 