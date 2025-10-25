# LLM Usage Tracking

This document explains how LLM usage tracking works in the A2A framework.

## API Overview

Two supported forms for recording usage:

```ts
// Shortcut form
ctx.recordUsage(0.05);

// Detailed form
ctx.recordUsage({
  cost: 0.12,
  kind: 'llm',            // 'llm' | 'embedding' | 'tool' | 'external_api' | 'storage' | 'network' | 'other'
  op: 'call',             // 'call' | 'stream' | 'embed' | 'invoke' | 'read' | 'write'
  provider: 'openai',
  model: 'gpt-4o-mini',
  tokens: { input: 210, output: 512 },
  // turn is auto-filled if omitted
});
```

Usage totals are aggregated and exposed on the final task status as:

```json
{
  "metadata": {
    "usage": {
      "totalCost": 0.73,
      "byKind": { "llm": 0.68, "external_api": 0.05 }
    }
  }
}
```

## Automatic Usage Tracking

The framework supports automatic tracking of LLM API usage without requiring manual `recordUsage` calls in agent implementations. This is done by connecting the callllm library's usage tracking features directly to the framework's recordUsage mechanism.

### How It Works

1. **Automatic Tracking**: When an LLM call is made, the cost is automatically tracked and recorded.
2. **Simplified API**: The `recordUsage` function accepts either a simple cost number or a detailed record.
3. **Aggregation**: Costs are aggregated into `totalCost` and `byKind` and included in the final task metadata.

## Usage in Agents

### Basic Usage (Automatic)

Most agents don't need to do anything special to track LLM usage. It's handled automatically when you use `ctx.llm`:

```typescript
// Usage is automatically tracked
const response = await ctx.llm.call("Your prompt here");

// No need to manually track usage - it's done for you!
```

### Manual Usage Recording (If Needed)

If you need to manually record usage (e.g., from external API calls), use one of the two supported forms:

```typescript
// Shortcut form
ctx.recordUsage(0.05);

// Detailed form
ctx.recordUsage({
  cost: 0.12,
  kind: 'llm',
  op: 'call',
  provider: 'openai',
  model: 'gpt-4o-mini',
  tokens: { input: 210, output: 512 },
  // turn is auto-filled if omitted
});
```

Examples:

```ts
// External API call
ctx.recordUsage(0.05); // counted under kind="other"
ctx.recordUsage({ cost: 0.05, kind: 'external_api', op: 'invoke', provider: 'stripe' });

// Tool invocation
ctx.recordUsage({ cost: 0.02, kind: 'tool', op: 'invoke', toolName: 'search' as any });
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

The LLM caller adapter sets up a usage callback that is triggered by the callllm library and forwards a detailed record:

```typescript
const usageCallback = (usage) => {
  if (usage.costs?.total) {
    ctx.recordUsage({
      cost: usage.costs.total,
      kind: 'llm',
      op: 'call',
      provider: config.provider,
      model: config.modelAliasOrName,
      tokens: usage.tokens
    });
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

The accumulated usage data is included in the `metadata` field of the task's final status:

```json
{
  "state": "completed",
  "timestamp": "2023-06-15T12:00:00.000Z",
  "metadata": {
    "usage": {
      "totalCost": 0.73,
      "byKind": { "llm": 0.68, "external_api": 0.05 }
    }
  }
}
```

Notes:
- `turn` is auto-attributed per record when available.
- The numeric shortcut is treated as `kind: 'other'` for aggregation.

## Budgets vs Costs

- Budgets are loop constraints configured per agent manifest (`budgets.maxTurns`, `budgets.latencyMs`). They do not represent money and don’t cap spend directly.
- Costs are aggregated from provider-reported usage and any manual records via `ctx.recordUsage`.
- See budgets examples in `apps/docs/loop/overview.md` (section: “Default budgets per agent”).