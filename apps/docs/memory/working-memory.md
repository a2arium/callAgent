# Working Memory & Cognitive Context API

## Overview

The Working Memory system provides agents with a cognitive workspace for managing:
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

## Working Memory API

### Goal Management

Track the current objective or goal of the agent:

```typescript
// Set the current goal
await ctx.setGoal("Help user with their question");

// Retrieve the current goal
const goal = await ctx.getGoal();
console.log(goal); // "Help user with their question"
```

### Thought Tracking

Record the agent's reasoning process and observations:

```typescript
// Add thoughts and observations
await ctx.addThought("User is asking about X");
await ctx.addThought("I should check knowledge base");
await ctx.addThought("Found relevant information in memory");

// Retrieve all thoughts
const thoughts = await ctx.getThoughts();
thoughts.forEach(thought => {
    console.log(`${thought.timestamp}: ${thought.content}`);
});
```

### Decision Making

Track key decisions made during task execution:

```typescript
// Make and record a decision
await ctx.makeDecision("approach", "use_existing_knowledge", "Found relevant info in memory");

// Retrieve a specific decision
const decision = await ctx.getDecision("approach");
console.log(decision);
// {
//   decision: "use_existing_knowledge",
//   reasoning: "Found relevant info in memory",
//   timestamp: "2024-01-15T10:30:00.000Z"
// }
```

### Working Variables

Store temporary data and context during task execution:

```typescript
// Store working variables
ctx.vars.userQuery = "How do I reset my password?";
ctx.vars.searchResults = [
    { title: "Password Reset Guide", relevance: 0.9 },
    { title: "Account Security", relevance: 0.7 }
];
ctx.vars.selectedApproach = "guided_walkthrough";

// Access variables
const query = ctx.vars.userQuery;
const results = ctx.vars.searchResults;
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
import { createAgent } from '@callagent/core';

export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        // Set the goal for this task
        await ctx.setGoal("Help user troubleshoot their login issue");
        
        // Record initial thoughts
        await ctx.addThought("User reports login problems");
        await ctx.addThought("Need to gather more information");
        
        // Store working variables
        ctx.vars.issueType = "login_failure";
        ctx.vars.userEmail = ctx.task.input.email;
        
        // Recall previous interactions with this user
        const previousIssues = await ctx.recall(`user:${ctx.vars.userEmail}:issues`, {
            limit: 3,
            type: 'episodic'
        });
        
        if (previousIssues.length > 0) {
            await ctx.addThought("Found previous issues for this user");
            await ctx.makeDecision("approach", "check_pattern", "User has history of similar issues");
            ctx.vars.isReturningUser = true;
        } else {
            await ctx.addThought("New user, no previous issues found");
            await ctx.makeDecision("approach", "standard_troubleshooting", "First-time issue");
            ctx.vars.isReturningUser = false;
        }
        
        // Perform troubleshooting based on decision
        const approach = await ctx.getDecision("approach");
        if (approach?.decision === "check_pattern") {
            await ctx.addThought("Analyzing pattern from previous issues");
            // ... pattern analysis logic
        } else {
            await ctx.addThought("Starting standard troubleshooting flow");
            // ... standard troubleshooting logic
        }
        
        // Remember this interaction for future reference
        await ctx.remember(`user:${ctx.vars.userEmail}:last_issue`, {
            type: ctx.vars.issueType,
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
await ctx.setGoal("Process user request");
await ctx.addThought("Analyzing user input");
ctx.vars.processingStage = "analysis";

// Long-term memory operations (existing)
await ctx.memory.semantic.set('user-preference', { theme: 'dark' });
await ctx.memory.episodic.append({ event: 'user_login', timestamp: Date.now() });

// Unified operations bridge both systems
await ctx.recall("user preferences"); // Can access both working and long-term memory
await ctx.remember("important_insight", data); // Automatically routed through MLO
```

## Memory Lifecycle Integration

All memory operations flow through the Memory Lifecycle Orchestrator (MLO):

```typescript
// These operations automatically go through MLO stages:
await ctx.addThought("Complex reasoning step");
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
// Check if working memory is initialized
if (!ctx.setGoal) {
    console.warn("Working memory not available in this context");
    // Fall back to traditional memory operations
}
```

**Memory operations failing:**
```typescript
try {
    await ctx.addThought("Processing step");
} catch (error) {
    ctx.logger.error("Working memory operation failed", error);
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
    await ctx.addThought(thought);
}
```

## Migration from Existing Code

Existing agents continue to work without modification. To add working memory capabilities:

```typescript
// Before (existing code)
export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        await ctx.memory.semantic.set('data', value);
        const data = await ctx.memory.semantic.get('data');
        await ctx.reply([{ type: 'text', text: 'Done' }]);
        ctx.complete();
    }
}, import.meta.url);

// After (with working memory)
export default createAgent({
    manifest: './agent.json',
    handleTask: async (ctx) => {
        // Add working memory operations
        await ctx.setGoal("Process user data");
        await ctx.addThought("Storing user data");
        
        // Existing operations continue to work
        await ctx.memory.semantic.set('data', value);
        const data = await ctx.memory.semantic.get('data');
        
        // Enhanced with working memory
        await ctx.makeDecision("storage", "semantic", "Data is structured");
        
        await ctx.reply([{ type: 'text', text: 'Done' }]);
        ctx.complete();
    }
}, import.meta.url);
```

## See Also

- [Memory System](./memory-system.md) - Long-term memory (semantic/episodic)
- [Multi-Tenant Memory](./multi-tenant-memory.md) - Tenant isolation
- [Memory SQL Adapter](./memory-sql-adapter.md) - SQL backend implementation 