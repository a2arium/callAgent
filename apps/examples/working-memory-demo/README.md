# Working Memory Demo Agent

This agent demonstrates the complete working memory functionality in callAgent, including goals, thoughts, decisions, variables, and MLO pipeline integration.

## Features Demonstrated

- **Goal Management**: Setting and updating agent objectives
- **Thought Chain**: Recording reasoning process and observations  
- **Decision Tracking**: Making and retrieving decisions with reasoning
- **Working Variables**: Storing temporary data during task execution
- **Memory Integration**: Seamless integration with semantic memory
- **MLO Pipeline**: All operations processed through 6-stage Memory Lifecycle Orchestrator

## Architecture

The agent uses the standard TaskContext API to interact with working memory:

- `ctx.setGoal()` / `ctx.getGoal()` - Goal management
- `ctx.addThought()` / `ctx.getThoughts()` - Thought tracking
- `ctx.makeDecision()` / `ctx.getDecision()` - Decision management
- `ctx.vars.*` - Working variables proxy
- `ctx.remember()` / `ctx.recall()` - Unified memory operations

All working memory operations flow through the MLO pipeline:
1. **Acquisition** - Input filtering and validation
2. **Encoding** - Attention and fusion mechanisms  
3. **Derivation** - Reflection and summarization
4. **Retrieval** - Indexing and matching
5. **Neural Memory** - Associative processing
6. **Utilization** - Context enhancement and RAG

## Usage

### Build and Run

```bash
# Build the agent
yarn build

# Run the agent using the runner CLI (from repository root)
node packages/core/dist/runner/runnerCli.js apps/examples/working-memory-demo/dist/AgentModule.js '{"input": "Demonstrate working memory capabilities"}'
```

### Development

```bash
# Development mode (requires ts-node)
yarn dev
```

## Structure

Following the standard callAgent agent pattern:

```
working-memory-demo/
├── AgentModule.ts          # Main agent implementation
├── package.json            # Package configuration
├── tsconfig.json           # TypeScript configuration
├── README.md               # This file
└── dist/                   # Built output
    └── AgentModule.js      # Compiled agent
```

## Configuration

The agent uses a minimal manifest following the hello-agent pattern:

```typescript
manifest: {
    name: 'working-memory-demo',
    version: '1.0.0'
}
```

## Output

The agent demonstrates:

1. Setting and retrieving goals
2. Adding thoughts and building a thought chain
3. Making decisions with reasoning
4. Using working variables for temporary data
5. Integrating with semantic memory
6. Processing through MLO pipeline stages

All operations are logged with detailed information about the MLO processing pipeline, showing how working memory enables sophisticated agent cognitive behaviors.

## Dependencies

- `@a2arium/core` - Core framework with working memory support
- `@a2arium/utils` - Shared utilities including logger

## Related Documentation

- [Working Memory API Documentation](../../docs/memory/working-memory-api.md)
- [MLO Architecture Guide](../../docs/memory/mlo-architecture.md)
- [Memory System Overview](../../docs/memory/) 