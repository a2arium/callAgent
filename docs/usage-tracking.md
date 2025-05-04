# LLM Usage Tracking

This document explains how LLM usage tracking works in the A2A framework.

## Automatic Usage Tracking

The framework now supports automatic tracking of LLM API usage without requiring manual `recordUsage` calls in agent implementations. This is done by connecting the callllm library's usage tracking features directly to the framework's recordUsage mechanism.

### How It Works

1. **Automatic Tracking**: When an LLM call is made, the cost is automatically tracked and recorded.
2. **Simplified API**: The `recordUsage` function now accepts a simple cost parameter instead of a complex usage structure.
3. **Cost Accumulation**: All costs are accumulated and included in the task metadata.

## Usage in Agents

### Basic Usage (Automatic)

Most agents don't need to do anything special to track LLM usage. It's handled automatically when you use `ctx.llm`:

```typescript
// Usage is automatically tracked
const response = await ctx.llm.call("Your prompt here");

// No need to manually track usage - it's done for you!
```

### Manual Usage Recording (If Needed)

If you need to manually record usage (e.g., from external API calls), you can use the simplified `recordUsage` API:

```typescript
// Record a specific cost
ctx.recordUsage({ cost: 0.05 }); // Object form
ctx.recordUsage(0.05);           // Numeric form (both work)
```

## Implementation Details

### LLM Factory

The framework uses an LLM factory to create LLM instances with automatic usage tracking:

```typescript
import { createLLMForTask } from '../../src/core/llm/index.js';

// Creates an LLM instance that automatically tracks usage
const llm = createLLMForTask(config, ctx);
```

### Usage Callback

The LLM caller adapter sets up a usage callback that is triggered by the callllm library:

```typescript
const usageCallback = (usage) => {
  if (usage.costs?.total) {
    recordUsage({ cost: usage.costs.total });
  }
}
```

## Migration Guide

### For New Agents

New agents don't need to worry about usage tracking - it's done automatically.

### For Existing Agents

Existing agents that manually track usage can:

1. Remove manual `recordUsage` calls for LLM responses
2. Update any remaining `recordUsage` calls to use the simplified format

## Benefits

- **Reduced Boilerplate**: Agents don't need to include usage tracking code
- **Consistent Tracking**: All LLM usage is tracked in a standardized way
- **Simplified API**: The recordUsage function is now simpler to use

## Usage Data in Task Results

The accumulated usage data is automatically included in the `metadata` field of the task's final status, using a simplified structure:

```json
{
  "state": "completed",
  "timestamp": "2023-06-15T12:00:00.000Z",
  "metadata": {
    "usage": {
      "cost": 0.0075
    }
  }
}
```

This simplified format makes it easier to consume and process usage data. The system internally accumulates all costs from various operations and presents only the final total cost. 