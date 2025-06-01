# Complete Memory System Demo (Phase 1-B)

This example demonstrates the complete Working Memory & Cognitive Context API implemented in Phase 1-B of the callAgent framework.

## Features Demonstrated

### 🧠 Working Memory Operations
- **Goal Management**: Set and retrieve agent goals with MLO processing
- **Thought Tracking**: Add and retrieve thoughts with processing metadata
- **Decision Making**: Make and retrieve decisions with reasoning
- **Working Variables**: Dynamic variable storage with async proxy access

### 🔄 Unified Memory Operations
- **Unified Recall**: Query across working, semantic, and episodic memory
- **Unified Remember**: Store information with automatic routing
- **Cross-memory type queries**: Search multiple memory stores simultaneously

### 🏗️ MLO Pipeline Integration
- **6-Stage Processing**: All memory operations flow through the Memory Lifecycle Orchestrator
- **Processing Metadata**: Track how memories are transformed through stages
- **Configuration Profiles**: Use conversational, basic, or research profiles
- **Metrics & Observability**: Monitor processing performance and statistics

### 🔄 Backward Compatibility
- **Existing APIs**: All existing semantic/episodic memory APIs work unchanged
- **Legacy Support**: Graceful degradation when new features aren't available
- **Migration Path**: Easy upgrade from existing memory implementations

## Usage

### Build and Run

```bash
# Build the example
yarn build

# Run the example (requires agent runner)
yarn test
```

### Example Input

```json
{
  "userName": "Alice",
  "message": "Show me how the memory system works"
}
```

### Expected Output

The agent will demonstrate:

1. **Working Memory Operations**
   - Setting goals and tracking thoughts
   - Managing working variables
   - Making decisions with reasoning

2. **Unified Memory Operations**
   - Storing and retrieving memories across types
   - Cross-memory queries and recall

3. **MLO Pipeline Processing**
   - Processing stages and transformations
   - Memory profile configuration
   - Performance metrics

4. **System Status**
   - Feature availability checks
   - Backward compatibility verification
   - Integration health status

## Memory Configuration

The agent uses the "conversational" memory profile with custom working memory settings:

```typescript
manifest: {
  name: "complete-memory-demo",
  version: "1.0.0",
  memory: {
    profile: "conversational",
    workingMemory: {
      derivation: {
        summarization: "SimpleSummarizer"
      }
    }
  }
}
```

## Architecture

This example showcases the complete Phase 1-B architecture:

- **UnifiedMemoryService**: Central memory coordination
- **MemoryLifecycleOrchestrator**: 6-stage processing pipeline
- **ProcessorFactory**: Dynamic processor instantiation
- **Working Memory Store**: Agent-isolated working memory
- **Context Integration**: TaskContext memory capabilities

## Key Implementation Details

### Working Variables Proxy
```typescript
// Async access to working variables
ctx.vars.userName = "Alice";
const turn = await ctx.vars.conversationTurn;
```

### Unified Operations
```typescript
// Store across memory types
await ctx.remember("user-insight", "Prefers detailed responses", {
  persist: true,
  type: 'semantic',
  importance: 'high'
});

// Query across memory types
const memories = await ctx.recall("user preferences", {
  sources: ['working', 'semantic'],
  limit: 5
});
```

### MLO Integration
```typescript
// All operations flow through MLO pipeline
await ctx.setGoal("Demonstrate complete memory system");
await ctx.addThought("This thought will be processed through 6 stages");

// Access processing metadata
const thoughts = await ctx.getThoughts();
const processingHistory = thoughts[0]?.processingMetadata?.processingHistory;
```

## Testing

This example serves as both a demonstration and integration test for the complete Phase 1-B memory system. It verifies:

- ✅ All working memory operations function correctly
- ✅ Unified memory operations work across types
- ✅ MLO pipeline processes all memory items
- ✅ Configuration profiles are applied correctly
- ✅ Backward compatibility is maintained
- ✅ Metrics and observability work as expected
- ✅ Error handling is robust and informative

## Next Steps

This example provides the foundation for Phase 2 enhancements:

- LLM integration for intelligent processing
- Advanced processor implementations
- Neural memory capabilities
- Enhanced cognitive context features 