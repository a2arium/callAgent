# Working Memory & MentalState

## Overview

Working Memory now lives inside a single MentalState snapshot (persisted as `snapshot.M`). It provides agents with a cognitive workspace for managing:
- Current goals and objectives
- Active thoughts and observations  
- Decisions made during task execution
- Temporary variables and context
- Integration with long-term memory

This system complements the existing semantic and episodic memory by providing a structured way to track an agent's active cognitive state during task execution.

## Key Concepts

### Memory Lifecycle Orchestrator (MLO)
Every memory operation flows through 6 sequential stages:
1. **Acquisition** - Filter, compress, consolidate
2. **Encoding** - Attention, multi-modal fusion
3. **Derivation** - Reflection, summarization, distillation, forgetting
4. **Retrieval** - Indexing, matching
5. **Neural Memory** - Associative memory, parameter integration
6. **Utilization** - RAG, context management, hallucination mitigation

### Working Memory vs Long-Term Memory

| Aspect | Working Memory | Long-Term Memory (Semantic/Episodic) |
|--------|----------------|--------------------------------------|
| **Purpose** | Active cognitive state | Persistent knowledge storage |
| **Scope** | Single task execution | Cross-task persistence |
| **Structure** | Structured (goals, thoughts, decisions) | Flexible (key-value, events) |
| **Lifecycle** | Created/destroyed with task | Persists across tasks |
| **Access** | Direct API methods | Memory adapter interface |

## Working Memory API (backed by MentalState)

### Goal Management (new hierarchy model)

Track the current objective or goal of the agent:

```typescript
const id = await ctx.goals.add({ title: 'Help user', type: 'short', priority: 1 });
await ctx.goals.update(id, { priority: 0.9 });
await ctx.goals.remove(id); // or complete via a domain-specific flow
const activeGoals = await ctx.goals.read({ status: 'active' });
```

### Thought Tracking

Record the agent's reasoning process and observations:

```typescript
// Add thoughts and observations
await ctx.thoughts.add("User is asking about X");
await ctx.thoughts.add("I should check knowledge base");
await ctx.thoughts.add("Found relevant information in memory");

// Retrieve all thoughts
// Thoughts retrieval is not exposed; persist summaries in memory as needed
```

### Decision Making

Track key decisions made during task execution:

```typescript
// Make and record a decision
await ctx.thoughts.add("Decision: approach use_existing_knowledge (Found relevant info in memory)");

// Retrieve a specific decision
// {
//   decision: "use_existing_knowledge",
//   reasoning: "Found relevant info in memory",
//   timestamp: "2024-01-15T10:30:00.000Z"
// }
```

### Working Variables (turn-level flush)

Store temporary data and context during task execution:

```typescript
// Store working variables (cached in-memory; flushed at turn end or await exit)
ctx.vars.set('userQuery', "How do I reset my password?");
ctx.vars.set('searchResults', [
    { title: "Password Reset Guide", relevance: 0.9 },
    { title: "Account Security", relevance: 0.7 }
]);
ctx.vars.set('selectedApproach', "guided_walkthrough");

// Nested path support with automatic object creation
ctx.vars.set('user.profile.name', 'John Doe');
ctx.vars.set('user.profile.email', 'john@example.com');
ctx.vars.set('user.preferences.theme', 'dark');
// Creates: { user: { profile: { name: 'John Doe', email: 'john@example.com' }, preferences: { theme: 'dark' } } }

// Alternative: Set complete nested objects directly
ctx.vars.set('user', {
    profile: {
        name: 'John Doe',
        email: 'john@example.com'
    },
    preferences: {
        theme: 'dark'
    }
});

// Both approaches allow the same access patterns:
ctx.vars.update('user.preferences.theme', (current) => {
    console.log('Current theme:', current); // 'dark'
    return current === 'dark' ? 'light' : 'dark'; // Toggle theme
});

// Access variables
const query = ctx.vars.get('userQuery');
const results = ctx.vars.get('searchResults');
const userName = ctx.vars.get('user.profile.name'); // 'John Doe'
const theme = ctx.vars.get('user.preferences.theme'); // 'light' (after update)
```

### Nested Path Support

The framework provides automatic nested path support for working variables, making it easy to work with complex data structures:

```typescript
// ctx.vars Methods
ctx.vars.set(key: string, value: unknown)           // Direct assignment, creates nested structure
ctx.vars.get(key: string)                          // Get nested value, returns undefined if path doesn't exist
ctx.vars.update(key: string, fn: (current) => any)  // Update with access to current value
ctx.vars.has(key: string)                          // Check if nested path exists
ctx.vars.delete(key: string)                       // Delete nested property
ctx.vars.merge(patch: Record<string, unknown>)     // Merge objects (dots are keys, not paths)
```

#### **Key Differences:**

| Method | Nested Path Support | Current Value Access | Use Case |
|--------|-------------------|---------------------|----------|
| `set('path.to.prop', value)` | ✅ Creates nested structure | ❌ No access to current | Direct assignment |
| `update('path.to.prop', fn)` | ✅ Creates nested structure | ✅ `fn(current)` gets current | Conditional updates |
| `get('path.to.prop')` | ✅ Reads nested values | N/A | Access nested data |
| `merge({ obj })` | ❌ Dots are object keys | N/A | Object merging |

#### **Examples:**

```typescript
// Alternative approaches for nested structures

// Approach 1: Build step by step using paths
ctx.vars.set('config.api.endpoint', 'https://api.example.com');
ctx.vars.set('config.api.version', 'v2');
ctx.vars.set('config.ui.theme', 'dark');
// Result: { config: { api: { endpoint: '...', version: 'v2' }, ui: { theme: 'dark' } } }

// Approach 2: Set complete nested object directly
ctx.vars.set('config', {
    api: {
        endpoint: 'https://api.example.com',
        version: 'v2'
    },
    ui: {
        theme: 'dark'
    }
});

// Both approaches allow the same access patterns:
const endpoint = ctx.vars.get('config.api.endpoint'); // 'https://api.example.com'
const theme = ctx.vars.get('config.ui.theme'); // 'dark'

// Update with current value access
ctx.vars.update('config.ui.theme', (current) => {
    return current === 'dark' ? 'light' : 'dark'; // Toggle theme
});

// Check existence
if (ctx.vars.has('config.api.endpoint')) {
    // Do something
}

// Delete nested property
ctx.vars.delete('config.api.version');

// Note: merge() treats dots as object keys, not paths
ctx.vars.merge({ 'config.api.timeout': 5000 });
// Creates: { 'config.api.timeout': 5000 } NOT nested structure
```

#### **When to Use Each Approach**

| Approach | Best For | Example |
|----------|----------|---------|
| **Path-based (`set('path.to.prop', value)`)** | Building structure incrementally, updating specific properties, when data arrives gradually | `ctx.vars.set('user.profile.email', userEmail)` |
| **Direct object (`set('key', {...})`)** | Complete objects ready at once, configuration data, API responses | `ctx.vars.set('config', apiResponse)` |

**Mixed Usage Pattern:**
```typescript
// Set initial configuration as complete object
ctx.vars.set('config', {
    api: { version: 'v1', timeout: 5000 },
    ui: { theme: 'light' }
});

// Update specific properties later as needed
ctx.vars.set('config.api.version', 'v2');
ctx.vars.update('config.ui.theme', (current) => current === 'light' ? 'dark' : 'light');
```

### Unified Memory Operations

Bridge between working memory and long-term memory:

```typescript
// Recall information from long-term memory
const memories = await ctx.recall("previous interactions", { 
    limit: 5,
    type: 'episodic'
});

// Remember important information for future use
await ctx.remember("user_preference", "detailed_explanations", { 
    persist: true,
    importance: 'high',
    type: 'semantic'
});
```

## Complete Example

Here's a comprehensive example showing how to use the working memory system in an agent:

```typescript
import { createAgent } from '@a2arium/core';

export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        // Set the goal for this task
        await ctx.goals.add({ title: "Help user troubleshoot their login issue" });
        
        // Record initial thoughts
        await ctx.thoughts.add("User reports login problems");
        await ctx.thoughts.add("Need to gather more information");
        
        // Store working variables
        ctx.vars.set('issueType', "login_failure");
        ctx.vars.set('userEmail', ctx.task.input.email);
        
        // Recall previous interactions with this user
        const previousIssues = await ctx.recall(`user:${ctx.vars.get('userEmail')}:issues`, {
            limit: 3,
            type: 'episodic'
        });
        
        if (previousIssues.length > 0) {
            await ctx.thoughts.add("Found previous issues for this user");
            await ctx.thoughts.add("Decision: approach check_pattern (User has history of similar issues)");
            ctx.vars.set('isReturningUser', true);
        } else {
            await ctx.thoughts.add("New user, no previous issues found");
            await ctx.thoughts.add("Decision: approach standard_troubleshooting (First-time issue)");
            ctx.vars.set('isReturningUser', false);
        }
        
        // Perform troubleshooting based on decision
        const approach = { decision: 'standard_troubleshooting' };
        if (approach?.decision === "check_pattern") {
            await ctx.thoughts.add("Analyzing pattern from previous issues");
            // ... pattern analysis logic
        } else {
            await ctx.thoughts.add("Starting standard troubleshooting flow");
            // ... standard troubleshooting logic
        }
        
        // Remember this interaction for future reference
        await ctx.remember(`user:${ctx.vars.get('userEmail')}:last_issue`, {
            type: ctx.vars.get('issueType'),
            resolved: true,
            timestamp: new Date().toISOString()
        }, {
            persist: true,
            type: 'episodic'
        });
        
        // Complete the task
        await ctx.reply([{
            type: 'text',
            text: `Issue resolved using ${approach?.decision} approach`
        }]);
        
        ctx.complete();
    }
}, import.meta.url);
```

## Integration with Existing Memory System

The working memory system integrates seamlessly with the existing semantic and episodic memory:

```typescript
// Working memory operations (new)
const gid = await ctx.addGoal({ title: 'Process user request', type: 'short', priority: 1 });
await ctx.thoughts.add("Analyzing user input");
ctx.vars.set('processingStage', "analysis");

// Long-term memory operations (existing)
await ctx.semantic?.add?.({ id: 'user-preference', value: { theme: 'dark' } });
await ctx.memory.episodic.append({ event: 'user_login', timestamp: Date.now() });

// Unified operations bridge both systems
await ctx.recall("user preferences"); // Can access both working and long-term memory
await ctx.remember("important_insight", data); // Automatically routed through MLO
```

## Memory Lifecycle Integration

All memory operations flow through the Memory Lifecycle Orchestrator (MLO):

```typescript
// These operations automatically go through MLO stages:
await ctx.thoughts.add("Complex reasoning step");
// → Acquisition (filter, compress)
// → Encoding (attention, fusion) 
// → Derivation (reflection, summarization)
// → Storage in working memory

await ctx.remember("key_insight", data);
// → Full MLO pipeline
// → Storage in appropriate long-term memory
```

## Configuration

Working memory behavior can be configured through agent manifests:

```json
{
    "name": "cognitive-agent",
    "version": "1.0.0",
    "memory": {
        "working": {
            "maxThoughts": 100,
            "autoSummarize": true,
            "summarizeThreshold": 50
        },
        "mlo": {
            "stages": {
                "acquisition": "default",
                "encoding": "attention-based",
                "derivation": "llm-summarizer"
            }
        }
    }
}
```

## Best Practices

### 1. Goal Setting
- Set clear, specific goals at the start of task execution
- Update goals if the task scope changes
- Use goals to guide decision-making

### 2. Thought Management
- Record key reasoning steps and observations
- Keep thoughts concise but informative
- Use thoughts to maintain context across complex operations

### 3. Decision Tracking
- Record important decisions with clear reasoning
- Use consistent decision keys for related choices
- Reference previous decisions when making new ones

### 4. Variable Usage
- Use working variables for temporary data that doesn't need persistence
- Choose descriptive variable names
- Clean up variables that are no longer needed

### 5. Memory Integration
- Use `recall()` to bring relevant long-term memories into working context
- Use `remember()` to persist important insights for future tasks
- Balance between working memory and long-term storage

## Troubleshooting

### Common Issues

**Working memory not available:**
```typescript
// New API: use ctx.goals/thoughts/decisions instead of legacy methods
if (!(ctx as any).goals?.add) {
    console.warn("Working memory not available in this context");
    // Fall back to traditional memory operations
}
```

**Memory operations failing:**
```typescript
import { logger } from '@a2arium/callagent-utils';

try {
    await ctx.thoughts.add("Processing step");
} catch (error) {
    logger.error("Working memory operation failed", error);
    // Continue with task execution
}
```

**Performance considerations:**
```typescript
// Batch operations when possible
const thoughts = [
    "Step 1: Analysis",
    "Step 2: Processing", 
    "Step 3: Response"
];

for (const thought of thoughts) {
    await ctx.thoughts.add(thought);
}
```

## Migration from Existing Code

Existing agents continue to work without modification. To add working memory capabilities:

```typescript
// Before (existing code)
export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        await ctx.semantic?.add?.({ id: 'data', value });
        const data = (await ctx.semantic?.read?.({}))?.find?.((x: any) => x?.id === 'data');
        await ctx.reply([{ type: 'text', text: 'Done' }]);
        ctx.complete();
    }
}, import.meta.url);

// After (with working memory)
export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        // Add working memory operations
        await ctx.goals.add({ title: "Process user data" });
        await ctx.thoughts.add("Storing user data");
        
        // Existing operations continue to work
        await ctx.semantic?.add?.({ id: 'data', value });
        const data = (await ctx.semantic?.read?.({}))?.find?.((x: any) => x?.id === 'data');
        
        // Enhanced with working memory
        await ctx.thoughts.add("Decision: storage semantic (Data is structured)");
        
        await ctx.reply([{ type: 'text', text: 'Done' }]);
        ctx.complete();
    }
}, import.meta.url);
```

## See Also

- [Memory System](./memory-system.md) - Long-term memory (semantic/episodic)
- [Multi-Tenant Memory](./multi-tenant-memory.md) - Tenant isolation
- [Memory SQL Adapter](./memory-sql-adapter.md) - SQL backend implementation 