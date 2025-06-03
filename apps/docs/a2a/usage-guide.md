# A2A Usage Guide

## Getting Started

Agent-to-Agent (A2A) communication allows agents to delegate tasks to other specialized agents while preserving context and memory state. This guide covers practical usage patterns and best practices.

## Basic Usage

### Simple Agent Call

```typescript
import { createAgent } from '@callagent/core';

export default createAgent({
  manifest: { name: 'orchestrator', version: '1.0.0' },
  
  async handleTask(ctx) {
    // Call another agent
    const result = await ctx.sendTaskToAgent('specialist-agent', {
      task: 'analyze',
      data: ctx.task.input
    });
    
    return result;
  }
}, import.meta.url);
```

### With Memory Context Transfer

```typescript
export default createAgent({
  manifest: { name: 'coordinator', version: '1.0.0' },
  
  async handleTask(ctx) {
    // Set up context
    await ctx.setGoal('Complete multi-step analysis');
    await ctx.addThought('Starting complex workflow');
    ctx.vars!.workflowId = 'workflow-123';
    
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
await ctx.setGoal('Analyze customer data');
await ctx.addThought('Customer satisfaction metrics needed');
await ctx.makeDecision('analysis-type', 'comprehensive', 'Full analysis required');
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
    await ctx.setGoal('Complete end-to-end data processing');
    
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
    await ctx.setGoal('Run parallel analysis tasks');
    
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
    
    await ctx.setGoal(`Process ${requestType} request`);
    await ctx.addThought(`Routing to appropriate specialist for ${requestType}`);
    
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
    
    await ctx.addThought(`${requestType} processing completed`);
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
    await ctx.addThought('Specialist agent unavailable, using fallback');
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
    await ctx.addThought('Agent call timed out, proceeding with partial results');
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
        
        await ctx.addThought(`Successfully processed with ${agentName}`);
        return result;
        
      } catch (error) {
        await ctx.addThought(`${agentName} failed: ${error.message}`);
        
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
  await ctx.addThought(`Analysis failed: ${error.message}`);
  await ctx.makeDecision('error-handling', 'fallback', 'Primary analysis failed');
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
import { PluginManager } from '@callagent/core';

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

## Examples

See the complete working example in `apps/examples/a2a-local-demo/` which demonstrates:
- Multi-agent workflows
- Memory context inheritance
- Error handling
- Performance patterns 