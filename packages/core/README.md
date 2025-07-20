# @a2arium/callagent-core

The core framework for the CallAgent AI agent system, providing agent orchestration, memory management, and A2A (Agent-to-Agent) communication capabilities.

## Installation

```bash
npm install @a2arium/callagent-core
```

or with yarn:

```bash
yarn add @a2arium/callagent-core
```

## Quick Start

### Basic Agent Creation

```typescript
import { createAgent, AgentManifest } from '@a2arium/callagent-core';

const manifest: AgentManifest = {
  name: 'hello-agent',
  version: '1.0.0',
  description: 'A simple greeting agent',
  inputs: {
    name: { type: 'string', required: true }
  },
  outputs: {
    message: { type: 'string' }
  }
};

class HelloAgent {
  async execute(inputs: { name: string }) {
    return {
      message: `Hello, ${inputs.name}!`
    };
  }
}

const agent = createAgent(manifest, new HelloAgent());

// Use the agent
const result = await agent.execute({ name: 'World' });
console.log(result.message); // "Hello, World!"
```

### Agent with Memory

```typescript
import { createAgent, WorkingMemoryRegistry } from '@a2arium/callagent-core';

class MemoryAgent {
  constructor(private memory: WorkingMemoryRegistry) {}

  async execute(inputs: { message: string }) {
    // Store in working memory
    await this.memory.store('user_message', inputs.message);
    
    // Retrieve from memory
    const stored = await this.memory.recall('user_message');
    
    return {
      echo: `You said: ${stored?.content || 'nothing'}`
    };
  }
}

const agent = createAgent(manifest, new MemoryAgent(workingMemory));
```

### A2A Communication

```typescript
import { A2AService } from '@a2arium/callagent-core';

const a2aService = new A2AService();

// Register agents
await a2aService.registerAgent('greeting-agent', greetingAgent);
await a2aService.registerAgent('translation-agent', translationAgent);

// Call another agent
const result = await a2aService.callAgent('translation-agent', {
  text: 'Hello',
  targetLanguage: 'spanish'
});
```

## Features

- **Agent Framework**: Create and manage AI agents with typed inputs/outputs
- **Memory System**: Working, episodic, semantic, and neural memory types
- **A2A Communication**: Agent-to-Agent messaging and coordination
- **Caching**: Built-in result caching for performance optimization
- **Streaming**: Real-time streaming of agent outputs
- **TypeScript Support**: Full type safety and IntelliSense

## Dependencies

- `@a2arium/callagent-types`: Core type definitions
- `@a2arium/callagent-memory-sql`: SQL-based memory persistence
- `@a2arium/callagent-utils`: Shared utilities

## License

MIT 