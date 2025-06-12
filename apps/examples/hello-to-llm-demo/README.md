# Hello-to-LLM Demo Agent

This example demonstrates A2A (Agent-to-Agent) communication using the dependency system. The agent automatically depends on the `llm-agent` and calls it to generate a joke about agent dependencies.

## Features

- **Automatic Dependency Resolution**: Declares `llm-agent` as a dependency in manifest
- **A2A Communication**: Uses `ctx.sendTaskToAgent()` to call the LLM agent
- **Streaming Progress**: Shows progress updates during execution
- **Error Handling**: Demonstrates proper A2A error handling

## Structure

- `agent.json` - External manifest declaring dependency on `llm-agent` (folder name matches agent name)
- `AgentModule.ts` - Main agent implementation
- `package.json` - Package configuration following standard pattern

**Note:** This example uses an external `agent.json` file because the folder name (`hello-to-llm-demo`) matches the agent name (`hello-to-llm-agent`). For multi-agent folders, only the main agent can use external JSON files.

## Dependencies

This agent depends on:
- `llm-agent` (loaded automatically via dependency resolution)

## Usage

### Build and Run
```bash
# Build the agent
cd apps/examples/hello-to-llm-demo
yarn build

# Run with dependency resolution (default)
yarn run-agent hello-to-llm-demo/dist/AgentModule.js --task='{"demo": true}'

# Run from root directory
yarn run-agent apps/examples/hello-to-llm-demo/dist/AgentModule.js --task='{"demo": true}'
```

### Expected Output
```
🔍 Resolving agent dependencies...
📦 Loaded 2 agents (including dependencies)
  ✅ hello-to-llm-agent (v1.0.0)
  ✅ llm-agent (v0.1.0)

🤝 Hello-to-LLM Demo Starting...
Progress: 20% - Calling LLM agent via A2A
Progress: 80% - LLM response received
✅ LLM Response received: { ... }
Status: completed
```

## Configuration

The LLM agent requires OpenAI API configuration. Set your API key:
```bash
export OPENAI_API_KEY=your_api_key_here
```

## Learning Points

1. **Dependency Declaration**: How to declare agent dependencies in external `agent.json` (when folder name matches agent name)
2. **Automatic Loading**: Dependencies are loaded automatically by the system
3. **A2A Communication**: Clean agent-to-agent communication patterns
4. **Error Propagation**: How errors flow between dependent agents 