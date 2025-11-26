# A2A Usage Guide

## Getting Started

Agent-to-Agent (A2A) communication allows agents to delegate tasks to other specialized agents while preserving context and memory state. This guide covers practical usage patterns and best practices.

## Basic Usage

### Simple Agent Call (non-blocking with durable handlers)

```typescript
import { createAgent } from '@a2arium/core';

export default createAgent({
  manifest: { name: 'orchestrator', version: '1.0.0' },
  
  async handleTask(ctx) {
    await ctx.sendTaskToAgent('specialist-agent', { task: 'analyze', data: ctx.task.input }, {
      onInputRequired: 'onSpecialistNeedsInput',
      onCompleted: 'onSpecialistDone'
    });
    return; // non-blocking
  }
}, import.meta.url);
export async function onSpecialistNeedsInput(ctx, ev: { prompt: string; schema?: unknown; token: string }) {
  await ctx.requestInput(ev.prompt, { schema: ev.schema, onProvided: 'handleSpecialistAnswer' });
}

export async function onSpecialistDone(ctx, ev: { input: unknown }) {
  await ctx.reply([{ type: 'text', text: `Done: ${JSON.stringify(ev.input)}` }]);
  ctx.complete(100, 'completed');
}

### Blocking Tool-like Call

```typescript
const result = await ctx.sendTaskToAgent('calculator', { op: 'sum', values: [1,2,3] });
await ctx.reply([{ type: 'text', text: `Sum: ${result.sum}` }]);
ctx.complete(100, 'completed');
```

### Per-call Cache Overrides

Agents can adjust result caching on a per-dispatch basis without touching the target manifest. Use the `cache` option to toggle caching or override TTL/exclude paths for a specific call while inheriting unspecified values from the manifest.

```typescript
await ctx.sendTaskToAgent('pricing-agent', payload, {
  cache: {
    enabled: true,          // force cache even if manifest disabled it
    ttlSeconds: 120,        // optional override; falls back to manifest when omitted
    excludePaths: ['time']  // optional override for cache key generation
  }
});

await ctx.sendTaskToAgent('live-agent', payload, {
  cache: { enabled: false }  // bypass cache for this invocation only
});
```

## Execution Model and Persistence

- **sendTaskToAgent (auto-dispatch)**: If `onCompleted` is provided in options, the call returns immediately and completion is delivered to the durable handler. If no `onCompleted` is provided, the call resolves with the child's result (blocking tool-like behavior).
- **requestInput (non-blocking, required handler)**: Always provide `onProvided` in options. The agent exits for the turn; the engine persists working memory and LLM state, and resumes when input arrives via `tasks/input`.
- **Engine-based child execution**: All child agents are executed through the `TaskEngine`. Working Memory (goal, thoughts, decisions, `ctx.vars`) and LLM conversation state are snapshotted every turn and restored before invoking any durable handler.
- **Group orchestration**: Use `ctx.allTasks([...], { onAllCompleted: '...', onAnyFailed: '...' })` to coordinate multiple child tasks durably.

### Group Orchestration (options-based handlers)

```typescript
await ctx.allTasks([
  { agent: 'extractor', input: { source: 'db' } },
  { agent: 'analyzer', input: { method: 'basic' } }
], {
  onAllCompleted: 'handleAllDone',
  onAnyFailed: 'handleAnyFailed'
});
return; // non-blocking; handlers will be invoked on completion
```

### Requesting Human Input (InputHandle)

```typescript
await ctx.requestInput('Which region?', { ttlMs: 900_000, schema: { type: 'string' }, onProvided: 'handleRegion', onExpired: 'handleRegionExpired' });
return;
```

### Notes on Markup and Parts in requestInput
- `requestInput` accepts the same payloads as `ctx.reply`: strings, `MessagePart`, `MessagePart[]`, including `type: 'markup'` with a Markup value.
- Parts are emitted to the task stream immediately (so buttons/location render) and the task enters `input-required` with the same parts available to the parent stream.
- The legacy `prompt` string remains supported for backward compatibility.

### Idempotency for tasks/input

When replying to an input-required task, include an `Idempotency-Key` header to safely retry without duplicating state transitions.

```
POST /a2a/rpc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tasks/input",
  "params": { "id": "<taskId>", "token": "<inputToken>", "input": "EU" }
}
Idempotency-Key: 2f0e1a...
```
```

### With Memory Context Transfer

```typescript
export default createAgent({
  manifest: { name: 'coordinator', version: '1.0.0' },
  
  async handleTask(ctx) {
    // Set up context with nested path support
    await ctx.goals.add({ title: 'Complete multi-step analysis' });
    await ctx.thoughts.add('Starting complex workflow');

    // Use nested paths for organized context
    ctx.vars.set('workflow.id', 'workflow-123');
    ctx.vars.set('workflow.stage', 'initialization');
    ctx.vars.set('workflow.metadata.priority', 'high');
    ctx.vars.set('workflow.metadata.startedAt', new Date().toISOString());
    ctx.vars.set('user.session.id', ctx.task.input.sessionId);

    // Alternative approach: Set complete nested objects
    ctx.vars.set('workflow', {
        id: 'workflow-123',
        stage: 'initialization',
        metadata: {
            priority: 'high',
            startedAt: new Date().toISOString()
        }
    });

    ctx.vars.set('user', {
        session: {
            id: ctx.task.input.sessionId
        }
    });

    // Both approaches enable the same access patterns:
    const workflowId = ctx.vars.get('workflow.id');
    const priority = ctx.vars.get('workflow.metadata.priority');
    
    // Call with full context inheritance
    const result = await ctx.sendTaskToAgent('data-analyzer', {
      dataSource: 'quarterly-reports'
    }, {
      inheritWorkingMemory: true,  // Transfer goals, thoughts, decisions, vars
      inheritMemory: true,         // Transfer semantic/episodic memory
      timeout: 60000              // 60 second timeout
    });
    
    return result;
  }
}, import.meta.url);
```

## Memory Inheritance Options

### Working Memory Inheritance

When `inheritWorkingMemory: true`:

- **Goals**: Target agent inherits the current goal
- **Thoughts**: Complete thought chain is transferred
- **Decisions**: Previous decisions are available
- **Variables**: Working variables are shared

```typescript
// Parent agent
await ctx.goals.add({ title: 'Analyze customer data' });
await ctx.thoughts.add('Customer satisfaction metrics needed');
await ctx.thoughts.add('Decision: analysis-type comprehensive (Full analysis required)');
ctx.vars!.customerId = '12345';

// Child agent will receive all of this context
const result = await ctx.sendTaskToAgent('analytics-agent', input, {
  inheritWorkingMemory: true
});
```

### Long-Term Memory Inheritance

When `inheritMemory: true`:

- **Semantic Memory**: Facts and structured knowledge
- **Episodic Memory**: Recent events and interactions
- **Memory Snapshot**: Relevant context for the task

```typescript
// Parent has stored relevant context
await ctx.remember('customer-profile', {
  id: '12345',
  tier: 'premium',
  preferences: ['email', 'detailed-reports']
}, { type: 'semantic' });

// Child agent can access this information
const result = await ctx.sendTaskToAgent('report-generator', input, {
  inheritMemory: true
});
```

## Common Patterns

### Sequential Agent Workflow

```typescript
export default createAgent({
  manifest: { name: 'workflow-orchestrator', version: '1.0.0' },
  
  async handleTask(ctx) {
    await ctx.goals.add({ title: 'Complete end-to-end data processing' });
    
    // Step 1: Data extraction
    const extractedData = await ctx.sendTaskToAgent('data-extractor', {
      source: ctx.task.input.dataSource
    }, { inheritWorkingMemory: true });
    
    // Step 2: Data transformation
    const transformedData = await ctx.sendTaskToAgent('data-transformer', {
      data: extractedData,
      format: 'normalized'
    }, { inheritWorkingMemory: true });
    
    // Step 3: Data analysis
    const analysis = await ctx.sendTaskToAgent('data-analyzer', {
      data: transformedData,
      analysisType: 'comprehensive'
    }, { 
      inheritWorkingMemory: true,
      inheritMemory: true 
    });
    
    return {
      extractedData,
      transformedData,
      analysis
    };
  }
}, import.meta.url);
```

### Parallel Agent Execution

```typescript
export default createAgent({
  manifest: { name: 'parallel-coordinator', version: '1.0.0' },
  
  async handleTask(ctx) {
    await ctx.goals.add({ title: 'Run parallel analysis tasks' });
    
    // Execute multiple agents in parallel
    const [
      financialAnalysis,
      marketAnalysis,
      riskAnalysis
    ] = await Promise.all([
      ctx.sendTaskToAgent('financial-analyzer', {
        period: 'Q4-2024'
      }, { inheritWorkingMemory: true }),
      
      ctx.sendTaskToAgent('market-analyzer', {
        segment: 'technology'
      }, { inheritWorkingMemory: true }),
      
      ctx.sendTaskToAgent('risk-analyzer', {
        factors: ['market', 'operational', 'financial']
      }, { inheritWorkingMemory: true })
    ]);
    
    return {
      financial: financialAnalysis,
      market: marketAnalysis,
      risk: riskAnalysis
    };
  }
}, import.meta.url);
```

### Conditional Agent Routing

```typescript
export default createAgent({
  manifest: { name: 'smart-router', version: '1.0.0' },
  
  async handleTask(ctx) {
    const requestType = (ctx.task.input as any).type;
    
    await ctx.goals.add({ title: `Process ${requestType} request` });
    await ctx.thoughts.add(`Routing to appropriate specialist for ${requestType}`);
    
    let result;
    switch (requestType) {
      case 'data-analysis':
        result = await ctx.sendTaskToAgent('data-specialist', ctx.task.input, {
          inheritWorkingMemory: true
        });
        break;
        
      case 'report-generation':
        result = await ctx.sendTaskToAgent('report-specialist', ctx.task.input, {
          inheritWorkingMemory: true,
          inheritMemory: true
        });
        break;
        
      case 'customer-service':
        result = await ctx.sendTaskToAgent('service-specialist', ctx.task.input, {
          inheritWorkingMemory: true,
          inheritMemory: true
        });
        break;
        
      default:
        result = await ctx.sendTaskToAgent('general-assistant', ctx.task.input, {
          inheritWorkingMemory: true
        });
    }
    
    await ctx.thoughts.add(`${requestType} processing completed`);
    return result;
  }
}, import.meta.url);
```

## Error Handling

### Agent Not Found

```typescript
try {
  const result = await ctx.sendTaskToAgent('non-existent-agent', input);
} catch (error) {
  if (error.message.includes('not found')) {
    await ctx.thoughts.add('Specialist agent unavailable, using fallback');
    const result = await ctx.sendTaskToAgent('general-agent', input);
    return result;
  }
  throw error;
}
```

### Timeout Handling

```typescript
try {
  const result = await ctx.sendTaskToAgent('slow-agent', input, {
    timeout: 10000 // 10 seconds
  });
} catch (error) {
  if (error.message.includes('timeout')) {
    await ctx.thoughts.add('Agent call timed out, proceeding with partial results');
    return { status: 'timeout', partialData: null };
  }
  throw error;
}
```

### Graceful Degradation

```typescript
export default createAgent({
  manifest: { name: 'resilient-coordinator', version: '1.0.0' },
  
  async handleTask(ctx) {
    const agents = ['specialist-1', 'specialist-2', 'fallback-agent'];
    
    for (const agentName of agents) {
      try {
        const result = await ctx.sendTaskToAgent(agentName, ctx.task.input, {
          inheritWorkingMemory: true,
          timeout: 15000
        });
        
        await ctx.thoughts.add(`Successfully processed with ${agentName}`);
        return result;
        
      } catch (error) {
        await ctx.thoughts.add(`${agentName} failed: ${error.message}`);
        
        if (agentName === 'fallback-agent') {
          throw error; // Last resort failed
        }
        // Try next agent
        continue;
      }
    }
  }
}, import.meta.url);
```

## Best Practices

### 1. Clear Responsibility Separation

Create agents with single, well-defined responsibilities:

```typescript
// Good: Specialized agents
const dataExtractor = createAgent({ 
  name: 'data-extractor' // Only extracts data
});
const dataAnalyzer = createAgent({ 
  name: 'data-analyzer' // Only analyzes data
});

// Avoid: Monolithic agents that do everything
```

### 2. Appropriate Context Inheritance

Only inherit context that the target agent needs:

```typescript
// Good: Selective inheritance
await ctx.sendTaskToAgent('report-generator', input, {
  inheritWorkingMemory: true,  // Needs workflow context
  inheritMemory: false         // Doesn't need historical data
});

// Avoid: Always inheriting everything (performance impact)
await ctx.sendTaskToAgent('simple-formatter', input, {
  inheritWorkingMemory: true,  // Unnecessary for simple formatting
  inheritMemory: true          // Unnecessary overhead
});
```

### 3. Meaningful Agent Names

Use descriptive names that support discovery:

```typescript
// Good: Descriptive names
'customer-service-agent'
'financial-analysis-agent'
'report-generation-agent'

// Avoid: Generic names
'agent1'
'helper'
'processor'
```

### 4. Proper Error Context

Add context to errors for better debugging:

```typescript
try {
  const result = await ctx.sendTaskToAgent('analyzer', input);
} catch (error) {
  await ctx.thoughts.add(`Analysis failed: ${error.message}`);
  await (ctx as any).decisions.add('error-handling', 'fallback', 'Primary analysis failed');
  throw new Error(`Analysis workflow failed: ${error.message}`);
}
```

### 5. Memory Management

Be mindful of memory transfer size:

```typescript
// Good: Transfer only relevant memory
const recentContext = await ctx.recall('recent-interactions', { limit: 5 });
await ctx.remember('transfer-context', recentContext);

await ctx.sendTaskToAgent('agent', input, {
  inheritMemory: true  // Only transfers recent context
});

// Avoid: Transferring large memory dumps
```

## Agent Discovery

### Exact Name Matching

```typescript
await ctx.sendTaskToAgent('data-analysis-agent', input);
```

### Fuzzy Matching

```typescript
// These all resolve to 'data-analysis-agent'
await ctx.sendTaskToAgent('data-analysis', input);
await ctx.sendTaskToAgent('data_analysis', input);
await ctx.sendTaskToAgent('dataanalysis', input);
```

### Checking Available Agents

```typescript
import { PluginManager } from '@a2arium/core';

// List all available agents
const availableAgents = PluginManager.listAgents();
console.log('Available agents:', availableAgents.map(a => a.name));
```

## Performance Considerations

### Context Size

- Working memory transfer: ~10-50ms
- Semantic memory transfer: ~20-100ms (depends on data size)
- Full context transfer: ~50-200ms

### Optimization Tips

1. **Selective Inheritance**: Only inherit needed context
2. **Agent Locality**: Keep frequently communicating agents together
3. **Batch Operations**: Group related agent calls when possible
4. **Timeout Management**: Set appropriate timeouts for different agent types

## Debugging

### Enable A2A Logging

```bash
export LOG_LEVEL=debug
```

### Common Log Messages

```
[A2AService] A2A task initiated - operationId: a2a_123, targetAgent: data-analyzer
[ContextSerializer] Context serialization completed - duration: 45ms
[A2AService] Target agent execution completed - success: true
```

### Troubleshooting Guide

| Problem | Solution |
|---------|----------|
| Agent not found | Check agent registration and name spelling |
| Context not transferred | Verify `inheritWorkingMemory: true` option |
| Timeout errors | Increase timeout or optimize target agent |
| Memory not available | Ensure semantic memory adapter is configured |
| Permission errors | Check tenant isolation settings |

## Migration from Direct Agent Calls

### Before (Direct Invocation)

```typescript
// Old approach - no context transfer
const targetAgent = await loadAgent('target-agent');
const result = await targetAgent.handleTask(basicContext);
```

### After (A2A Communication)

```typescript
// New approach - full context transfer
const result = await ctx.sendTaskToAgent('target-agent', input, {
  inheritWorkingMemory: true,
  inheritMemory: true
});
```

## Advanced Topics

For detailed technical information, see:

- **[Child Input Required Flow](../a2a/child-input-required-flow.md)** - Deep dive into parent-child input handling, database persistence, and troubleshooting
- **[Durable Handlers and Persistence](../durable-handlers-and-persistence.md)** - Working memory persistence, context restoration, and handler lifecycle management  
- **[TaskEngine A2A Integration](../task-engine-a2a-integration.md)** - Technical architecture of TaskEngine and A2AService coordination

### Replies vs Returns (A2A Mapping)

- **ctx.reply() → Artifacts (user-facing output)**: Use `ctx.reply` to emit responses intended for the end-user. In A2A terms these are emitted as artifacts on the parent task stream.
- **return value → Internal data (parent-handled result)**: The value you `return` from an agent handler is delivered to the parent via a blocking call result or the `onCompleted` handler.

Both methods are supported and complementary:
- Use `ctx.reply` for content users should see during execution or as final output.
- Use `return` for structured results the parent agent will consume.

## Examples

See the complete working example in `apps/examples/a2a-local-demo/` which demonstrates:
- Multi-agent workflows
- Memory context inheritance
- Error handling
- Performance patterns

## See Also

Additional documentation:
- [A2A Architecture](./architecture.md) - System architecture overview
- [A2A API Reference](./api-reference.md) - Complete API documentation
- [Working Memory](../memory/working-memory.md) - Working memory system
- [Memory SQL Adapter](../memory-sql-adapter.md) - Database persistence layer 