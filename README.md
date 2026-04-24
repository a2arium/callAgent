# CallAgent - APLRET AI Agent Framework 🤖

A production-ready TypeScript AI agent framework implementing the **APLRET** (Attention → Perception → Learning → Reasoning/Policy → Shield → Execution → Transition) brain-inspired architecture with comprehensive **A2A** (Agent-to-Agent) communication support.

## 🏗️ Architecture Overview

CallAgent implements a **brain-inspired cognitive loop** with six explicit modules plus a safety guard:

```mermaid
flowchart LR
    A[Attention] --> P[Perception]
    P --> L[Learning]
    L --> R[Policy/Reasoning]
    R --> S[Shield]
    S --> E[Execution]
    E --> T[Transition]
    T -.-> A
```

### Core Components

- **🎯 APLRET Cognitive Architecture**: Six explicit modules implementing brain-inspired intelligence
- **🔄 A2A Communication**: Automatic dependency resolution and agent-to-agent communication
- **🧠 Typed Intent System**: Policy emits discriminated unions, Execution handles exhaustively
- **📡 Stage Dispatcher Pattern**: Explicit control flow with typed stages and runtime invariants
- **⚡ Effect Safety**: Budget-aware, timeout-protected external calls with automatic retries
- **💾 Memory System**: Multi-layered memory with semantic, episodic, and working memory support
- **🌊 Streaming Support**: Real-time response streaming via Server-Sent Events (SSE)

## 🚀 Quick Start

### 1. Installation
```bash
# Install the framework
npm install @a2arium/callagent-core

# Optional: SQL memory persistence
npm install @a2arium/callagent-memory-sql
```

### 2. Create Your First APLRET Agent
```typescript
import { createAgent } from '@a2arium/callagent-core';

// Define typed stages for explicit control flow
type Stage = 'idle' | 'awaiting_input' | 'completed';

// Define typed intents (Policy decides WHAT to do)
type Intent =
  | { kind: 'prompt_user' }
  | { kind: 'answer_with_llm'; query: string };

// Create typed façade for ctx.vars
const V = {
  stage: (ctx) => ctx.vars.get('stage') ?? 'idle',
  setStage: (ctx, stage) => ctx.vars.set('stage', stage),
  token: (ctx) => ctx.vars.get('token'),
  setToken: (ctx, token) => ctx.vars.set('token', token),
  completeCalled: (ctx) => Boolean(ctx.vars.get('completeCalled')),
  setCompleteCalled: (ctx, v) => ctx.vars.set('completeCalled', v)
};

export const agent = createAgent({
  manifest: {
    name: 'my-agent',
    version: '1.0.0',
    runMode: 'loop',
    budgets: { maxTurns: 5 }
  },
  llmConfig: {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful assistant.',
    historyMode: 'dynamic'
  },

  // A - Attention: What to focus on
  attention: (m, env) => ({
    wantPrompt: !env.inbox.current.some(o => o.source === 'user')
  }),

  // P - Perception: Normalize input
  perception: (env) => {
    const latest = env.inbox.current.find(o => o.source === 'user');
    const value = (latest?.payload as { value?: string | { text?: string } })?.value;
    const text = typeof value === 'string' ? value : value?.text;
    return {
      text,
      eventType: latest ? 'user_message' : 'idle'
    };
  },

  // L - Learning: Update MentalState (immutable, pure)
  learning: (prev, _action, obs) => ({
    ...prev,
    memory: {
      ...prev.memory,
      sensory: { current: obs.text }
    }
  }),

  // R - Policy: Decide WHAT to do (pure function of MentalState)
  policy: (m): Intent => {
    const userText = m.memory?.sensory?.current;
    return userText
      ? { kind: 'answer_with_llm', query: userText }
      : { kind: 'prompt_user' };
  },

  // S - Shield: Safety checks
  shield: (m, intent) => ({
    action: 'pass',
    intent
  }),

  // E - Execution: HOW to do it (stage dispatcher)
  execution: async (intent, ctx, m) => {
    const stage = V.stage(ctx);

    if (stage === 'idle' && intent.kind === 'prompt_user') {
      await ctx.reply('How can I help you?');

      // ✅ NEW: Input-first approach with automatic token and stage management
      const handle = await ctx.requestInput('Your message', {
        setStage: 'awaiting_input'  // Automatically sets stage and token
      });
      const token = handle.token;

      return { kind: 'ask_user', token };
    }

    if (stage === 'awaiting_input' && intent.kind === 'answer_with_llm') {
      const response = await ctx.llm.call(intent.query);
      await ctx.reply(response[0]?.content);
      ctx.complete(100, 'completed');
      V.setCompleteCalled(ctx, true);
      V.setStage(ctx, 'completed');
      return { kind: 'internal', done: true };
    }

    return { kind: 'internal', done: true };
  },

  // T - Transition: Control loop flow
  transition: (_env, exec, ctx) => {
    if (exec.kind === 'ask_user') {
      return { kind: 'await_input', token: exec.token };
    }
    if (V.completeCalled(ctx)) {
      return { kind: 'complete', result: { ok: true } };
    }
    return { kind: 'continue' };
  }
}, import.meta.url);
```

### 3. Run Your Agent
```typescript
import { agent } from './my-agent.js';

const result = await agent.execute({
  input: "Hello, agent!"
});

console.log(result);
```

---

## 📚 Documentation

- **[APLRET Architecture Guide](apps/docs/loop/aplret-stage-dispatcher.md)** - Complete APLRET implementation guide (2,400+ lines)
- **[A2A Communication](docs/a2a/architecture.md)** - Agent-to-agent communication protocols
- **[Memory System](docs/memory/)** - Multi-layered memory architecture
- **[Examples](apps/examples/)** - 20+ production-ready example agents

---

## ✨ Key Features

### 🧠 APLRET Cognitive Architecture
- **Brain-inspired design** based on cognitive science research
- **Six explicit modules**: Attention → Perception → Learning → Policy → Shield → Execution → Transition
- **Typed intent system** for clear reasoning and exhaustive handling
- **Stage dispatcher pattern** with runtime invariants

### 🔄 A2A Communication
- **Automatic dependency resolution** with topological loading
- **Agent-to-agent delegation** via `ctx.sendTaskToAgent()`
- **Circular dependency detection** with clear error messages
- **Multi-agent coordination** patterns

### ⚡ Effect Safety & Performance
- **Budget-aware execution** with automatic cost tracking
- **Timeout protection** and automatic retries for external calls
- **Streaming support** via Server-Sent Events (SSE)
- **LLM conversation history** persistence across async operations

### 💾 Advanced Memory System
- **Multi-layered memory**: Semantic, Episodic, and Working memory
- **SQL persistence** with Prisma ORM
- **Tenant isolation** and permission management
- **Memory lifecycle** orchestration

### 🛡️ Production-Ready Safety
- **Shield module** for PII detection and policy enforcement
- **Pure functional modules** for predictable behavior
- **Type safety** with discriminated unions and exhaustive matching
- **Runtime invariants** for stage validation

---

## 🎯 Agent Types

### 1. **Simple Agents**
For basic request-response patterns with minimal configuration.

### 2. **Loop Agents** (APLRET)
For complex conversational agents requiring:
- Multi-turn conversations with context persistence
- Complex decision-making and planning
- Tool coordination and external service integration
- Human-in-the-loop workflows

### 3. **Multi-Agent Systems**
For distributed systems requiring:
- Agent specialization and delegation
- Coordinated task execution
- Hierarchical agent architectures

---

## 🏗️ Project Structure

```
callagent/
├── packages/
│   ├── core/           # APLRET framework engine
│   ├── memory-sql/     # SQL memory persistence
│   ├── types/          # Shared TypeScript types
│   ├── utils/          # Utilities and logging
│   └── chat-bridge/    # External integrations
├── apps/
│   ├── examples/       # 20+ example agents
│   │   ├── hello-agent/           # Simple greeting agent
│   │   ├── loop-agent-mini/       # APLRET demo with LLM history
│   │   ├── interactive-a2a-demo/  # Multi-agent communication
│   │   ├── memory-usage/          # Memory system demo
│   │   └── ...                    # Many more examples
│   └── docs/           # Comprehensive documentation
├── planned_architecture/  # Detailed design specs
└── scripts/            # Build utilities
```

---

## 🚀 Development Setup

### Install Dependencies
```bash
yarn install
```

### Build the Framework
```bash
yarn build
```

### Run Examples
```bash
# Simple agent
yarn run:hello

# APLRET loop agent with streaming
yarn run:loop-mini:dev

# Multi-agent demo
yarn run:interactive-a2a

# All available scripts
yarn run:llm
yarn run:memory
yarn run:csv-parser
yarn run:data-analyzer

# Telegram bridge demo (requires setup)
yarn run:telegram-demo
```

### Telegram Bridge Demo Setup

The Telegram bridge demo requires additional setup since it connects to external services:

1. **Copy environment template:**
```bash
cp apps/examples/telegram-bridge-demo/env.example apps/examples/telegram-bridge-demo/.env
```

2. **Fill in environment variables in `.env`:**
```bash
# Get from @BotFather on Telegram
CM_TG_BOT_TOKEN="your-telegram-bot-token"
# Port for webhook (88 works well for local)
CM_TG_WEBHOOK_PORT=88
# Your Telegram chat ID for testing
CM_TG_CHAT_ID="your-chat-id"
# PostgreSQL database for session storage
CHAT_DATABASE_URL="postgres://user:pass@host:5432/dbname"
```

3. **Run the demo:**
```bash
# Development mode (no build needed)
yarn run:telegram-demo:dev

# Production mode (requires build)
yarn run:telegram-demo
```

The demo starts a webhook server that receives Telegram messages and responds using the enhanced input-first `requestInput` API with automatic token and stage management.

### Development Commands
```bash
# Run tests
yarn test

# Lint all packages
turbo run lint

# Build all packages
turbo run build

# Run specific package tests
turbo run test --filter=packages/core
```

### TypeScript Development
The framework uses **ESM modules** throughout. When developing:

- Use `yarn dev` for rapid TypeScript iteration
- Use `yarn run-agent` with compiled `.js` agent module paths; use `yarn dev` (or TS loaders) for `.ts` source modules
- All relative imports require explicit `.js` extensions
- Use `import.meta.url` for agent module resolution

## 🔄 A2A Communication & Multi-Agent Systems

The framework provides comprehensive **Agent-to-Agent (A2A) communication** with automatic dependency resolution:

### Core A2A Features
- **Automatic Dependency Resolution**: Agents declare dependencies in manifests
- **Topological Loading**: Dependencies loaded in correct order with circular dependency detection
- **Agent Delegation**: Call other agents via `ctx.sendTaskToAgent()`
- **Multi-Agent Coordination**: Support for hierarchical agent systems

### Quick Multi-Agent Example

```typescript
// agent.json
{
  "name": "coordinator-agent",
  "dependencies": {
    "agents": ["data-processor", "report-generator"]
  }
}

// AgentModule.ts
export default createAgent({
  manifest: 'agent.json',

  async handleTask(ctx) {
    // Delegate to specialized agents
    const data = await ctx.sendTaskToAgent('data-processor', {
      source: ctx.input.dataSource
    });

    const report = await ctx.sendTaskToAgent('report-generator', {
      data: data.processed
    });

    return { report: report.content };
  }
}, import.meta.url);
```

### APLRET Multi-Agent Patterns

For complex multi-agent systems using the APLRET architecture:

```typescript
export default createAgent({
  manifest: {
    name: 'orchestrator',
    runMode: 'loop',
    dependencies: { agents: ['specialist-1', 'specialist-2'] }
  },

  // APLRET modules for multi-agent coordination
  policy: (m): Intent => {
    const task = m.worldModel.currentTask;

    if (task.type === 'data_analysis') {
      return {
        kind: 'delegate_to_child',
        childAgentId: 'data-analyst',
        input: task.data
      };
    }

    if (task.type === 'report_generation') {
      return {
        kind: 'delegate_to_child',
        childAgentId: 'report-writer',
        input: task.analysis
      };
    }

    return { kind: 'prompt_user' };
  },

  execution: async (intent, ctx) => {
    if (intent.kind === 'delegate_to_child') {
      const handle = await ctx.sendTaskToAgent(intent.childAgentId, intent.input);
      V.setToken(ctx, handle.token);
      V.setStage(ctx, 'awaiting_child');
      return { kind: 'subagent', token: handle.token };
    }

    // Handle other intents...
  },

  // ... other APLRET modules
}, import.meta.url);
```

## 🌊 Streaming Support

The framework supports both **buffered and streaming responses**:

- **Buffered Mode**: Complete response after task completion
- **Streaming Mode**: Real-time partial results via Server-Sent Events (SSE)

Agent code remains identical - the framework handles the delivery method automatically.

### Streaming Example

```typescript
export default createAgent({
  async handleTask(ctx) {
    // Send progress updates
    await ctx.progress({
      state: 'processing',
      progress: 25
    });

    // Stream partial content
    await ctx.reply([{
      type: 'text',
      text: 'Processing step 1...'
    }], { append: true });

    // Continue processing...
    await ctx.progress({ progress: 50 });

    // Complete the task
    ctx.complete(100, 'completed');
    return { result: 'Task completed successfully' };
  }
}, import.meta.url);
```

### Try Streaming Examples

```bash
# Streaming APLRET agent
yarn run:loop-mini

# Interactive multi-agent demo with streaming
yarn run:interactive-a2a
```

---

## 🛠️ Advanced Usage

### External API Integration with Effect Safety

```typescript
import { runEffect } from '@a2arium/callagent-core';

export default createAgent({
  execution: async (intent, ctx) => {
    if (intent.kind === 'fetch_external_data') {
      // ✅ Safe external API call with timeout and retries
      const data = await runEffect(
        () => fetch(intent.url).then(r => r.json()),
        { timeoutMs: 10000, maxRetries: 3 }
      );

      await ctx.reply(`Data fetched: ${JSON.stringify(data)}`);
      return { kind: 'internal', done: true };
    }
  }
}, import.meta.url);
```

### Memory System Integration

```typescript
export default createAgent({
  learning: (prev, _action, obs) => {
    // Store conversation in semantic memory
    if (obs.text) {
      return {
        ...prev,
        memory: {
          ...prev.memory,
          sensory: { current: obs.text },
          longTerm: {
            ...prev.memory.longTerm,
            episodic: [
              ...prev.memory.longTerm.episodic,
              {
                t: Date.now(),
                content: obs.text,
                type: 'user_message'
              }
            ]
          }
        }
      };
    }

    return prev;
  },

  policy: (m) => {
    // Use memory for context-aware decisions
    const recentHistory = m.memory.longTerm.episodic.slice(-5);
    const context = recentHistory.map(e => e.content).join('\n');

    return {
      kind: 'answer_with_llm',
      query: m.memory.sensory.current,
      context
    };
  }
}, import.meta.url);
```

---

## 📖 Learn More

### Documentation
- **[APLRET Architecture Guide](apps/docs/loop/aplret-stage-dispatcher.md)** - Complete implementation guide
- **[A2A Communication](planned_architecture/a2a_specs/)** - Multi-agent protocols
- **[Memory System](planned_architecture/memory/)** - Memory architecture details
- **[API Reference](packages/core/)** - Full API documentation

### Examples
- **[Hello Agent](apps/examples/hello-agent/)** - Simple starter agent
- **[APLRET Mini Demo](apps/examples/loop-agent-mini/)** - Minimal APLRET implementation
- **[Interactive A2A Demo](apps/examples/interactive-a2a-demo/)** - Multi-agent communication
- **[Memory Usage](apps/examples/memory-usage/)** - Memory system demonstration
- **[20+ More Examples](apps/examples/)** - Covering all framework features

### Architecture Papers
- **[Brain-Inspired Foundation Agents](https://arxiv.org/abs/2504.01990)** - Academic foundation for APLRET
- **[Planned Architecture](planned_architecture/)** - Complete design specifications

## 📦 Package Documentation

- **[@a2arium/callagent-core](packages/core/README.md)** - APLRET framework and agent creation
- **[@a2arium/callagent-memory-sql](packages/memory-sql/README.md)** - SQL-based memory persistence
- **[@a2arium/callagent-types](packages/types/README.md)** - Shared TypeScript types
- **[@a2arium/callagent-utils](packages/utils/README.md)** - Shared utilities

---

## 🏗️ Production Deployment

### Database Setup

For production use with persistent memory:

```bash
# Set database URL (environment variable or config)
export MEMORY_DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

# Initialize database schema
npx @a2arium/callagent-memory-sql setup

# Optional: View database with Prisma Studio
npx @a2arium/callagent-memory-sql studio
```

### Environment-Agnostic Design

CallAgent is designed for **production environments**:

- ✅ **No file system dependencies** (environment-agnostic configuration)
- ✅ **Container-ready** (Docker, Kubernetes support)
- ✅ **Cloud-native** (works with managed databases, secret managers)
- ✅ **Multi-tenant support** with isolation and permissions

### Production Configuration

```typescript
// Production agent with environment-specific config
export const agent = createAgent({
  manifest: {
    name: 'production-agent',
    runMode: 'loop',
    budgets: { maxTurns: 10 }
  },

  // APLRET modules as shown in quick start
  // ...
}, import.meta.url);

// Initialize with your deployment platform's configuration
await agent.initialize({
  database: {
    url: await getSecret('MEMORY_DATABASE_URL')
  },
  llm: {
    apiKey: await getSecret('LLM_API_KEY'),
    provider: 'your-provider'
  }
});
```

---

## 🔧 Framework Development

### Development Environment

This monorepo uses **Turborepo** and **Yarn workspaces** for modular development:

```bash
# Install dependencies
yarn install

# Build all packages
turbo run build

# Run tests
turbo run test

# Run specific package tests
turbo run test --filter=packages/core

# Development mode with hot reload
yarn dev examples/loop-agent-mini/AgentModule.ts '{}'
```

### Project Structure

```
callagent/
├── packages/
│   ├── core/           # APLRET framework engine
│   ├── memory-sql/     # SQL memory persistence
│   ├── types/          # Shared TypeScript types
│   ├── utils/          # Logging and utilities
│   └── chat-bridge/    # External platform integrations
├── apps/
│   ├── examples/       # 20+ example agents demonstrating patterns
│   └── docs/           # APLRET documentation
├── planned_architecture/  # Comprehensive design specifications
└── scripts/            # Build and development utilities
```

### TypeScript & ESM

The framework uses **modern TypeScript** with **ES modules**:

- `"type": "module"` in all `package.json` files
- `"module": "nodenext"` and `"moduleResolution": "nodenext"` in TypeScript configs
- Explicit `.js` extensions for relative imports
- `import.meta.url` for agent module resolution

### Environment Configuration

For framework development, use the root `.env` file for shared configuration. The framework automatically handles environment propagation during development while remaining environment-agnostic in production.

### Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for:
- Development setup and testing
- Code style and conventions
- Pull request process
- Release process

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🤝 Community

- **Documentation**: [Complete APLRET Guide](apps/docs/loop/aplret-stage-dispatcher.md)
- **Issues**: [GitHub Issues](https://github.com/your-repo/callagent/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-repo/callagent/discussions)

---

**CallAgent** - Production-ready APLRET architecture with comprehensive A2A communication support. 