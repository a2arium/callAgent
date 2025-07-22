# NOTE: This is a very early work in progress.

# Working in the Monorepo

This project uses a Turborepo-based monorepo structure with Yarn workspaces for modular development. All core packages and example apps live under `packages/` and `apps/` respectively.

## Getting Started

1. **Install dependencies:**
   ```bash
   yarn install
   ```
   This will install all dependencies for every workspace package and app, using hoisting for efficiency.

2. **Run lint, build, or test for all packages/apps:**
   ```bash
   turbo run lint
   turbo run build
   turbo run test
   ```
   You can also run these for a specific package/app:
   ```bash
   turbo run test --filter=packages/memory-sql
   ```

3. **Add new packages or apps:**
   - Place new packages in `packages/`
   - Place new example or documentation apps in `apps/`

4. **Workspace Structure:**
   - `packages/` — Core framework, adapters, shared types, utilities
   - `apps/` — Example agents, documentation site, integration demos

5. **More Information:**
   - See the `monorepo.mdc` rule in `.cursor/rules` for conventions and best practices.

---

# CallAgent AI Framework 🤖

A modern, flexible AI agent framework that can be used both as a **consumable library** and for **framework development**. Build intelligent agents with memory, LLM integration, and agent-to-agent communication.

## 🔗 Quick Navigation

- **📚 [Using CallAgent as a Library](#using-callagent-as-a-library-📚)** - For building applications with CallAgent
- **🛠️ [Framework Development](#framework-development-🛠️)** - For contributing to CallAgent itself

---

## Features

### Automatic LLM Usage Tracking

The framework now automatically tracks LLM API usage without requiring manual calls to `recordUsage`. This tracking works with the [callllm](https://www.npmjs.com/package/callllm) library to:

- Record costs for all LLM calls automatically
- Accumulate costs throughout the task lifecycle
- Include usage data in the task completion metadata

Agent developers don't need to add any special code - the framework handles this automatically whenever an agent uses `ctx.llm.call()` or `ctx.llm.stream()`.

[Read more in the usage tracking documentation](docs/usage-tracking.md)

## Getting Started

1.  **Install dependencies:**
    ```bash
    yarn install
    ```

2.  **Build the framework core:**
    ```bash
    yarn build
    ```
    This compiles the `src` directory to `dist` - the output you would publish as an npm package.

3.  **Run example agents in development mode (using TypeScript directly):**
    ```bash
    yarn dev examples/hello-agent/AgentModule.ts '{"name": "Developer"}'
    ```
    The development mode uses `ts-node/esm` to run TypeScript files directly, which is perfect for rapid prototyping.

4.  **If you want to build and run a compiled example:**
    
    First, manually compile your example agent:
    ```bash
    # Create an examples directory in dist
    mkdir -p dist/examples/hello-agent
    
    # Copy the agent.json file
    cp examples/hello-agent/agent.json dist/examples/hello-agent/
    
    # Compile the TypeScript to JavaScript
    npx tsc --outDir dist/examples examples/hello-agent/AgentModule.ts --module NodeNext
    ```
    
    Then run it:
    ```bash
    yarn start dist/examples/hello-agent/AgentModule.js '{"name": "Developer"}'
    ```

## Project Structure

-   `src/`: Framework core source code
    -   `core/plugin/`: Plugin definition and loading
    -   `runner/`: Minimal local runner
    -   `shared/types/`: Shared TypeScript types
    -   `config/`: Minimal configuration loading
-   `examples/`: Example agent implementations
    -   `hello-agent/`: Simple greeting agent example
-   `dist/`: Compiled JavaScript output (generated when you run `yarn build`)

## Development vs. Production

This setup keeps a clear separation between:

1. **Framework development** - The code in `src/` is the actual framework that gets compiled and published
2. **Agent development** - The code in `examples/` is for demonstration and testing

When you're developing agents using this framework:

- Use `yarn dev` to iterate quickly with TypeScript examples
- Use `yarn build` + `yarn start` for the compiled output validation

## Overview

(Describe the project purpose and core concepts here based on the minimal architecture)

## Agent Dependencies & A2A Communication ✓

The framework provides automatic dependency resolution for Agent-to-Agent (A2A) communication:

- **Automatic Dependency Resolution**: Agents declare dependencies in their manifests
- **Topological Loading**: Dependencies loaded in correct order automatically  
- **A2A Communication**: Agents can call other agents via `ctx.sendTaskToAgent()`
- **Circular Dependency Detection**: Prevents infinite loops and provides clear error messages

### Quick Example

```typescript
// agent.json (only when folder name matches agent name)
{
  "name": "hello-to-llm-agent",
  "dependencies": { "agents": ["hello-agent"] }
}

// AgentModule.ts  
export default createAgent({
  async handleTask(ctx) {
    const result = await ctx.sendTaskToAgent('hello-agent', { name: 'User' });
    return { success: true, dependencyResult: result };
  }
}, import.meta.url);
```

**Important:** For multi-agent folders, only the main agent (whose name matches the folder) can use external JSON. All other agents must use inline manifests.

[Read the complete Agent Dependencies documentation](docs/agent-dependencies.md)

## Streaming Support ✓

This framework supports both buffered and streaming responses through the A2A protocol:

- **Buffered mode (`tasks/send`)**: Returns a complete response after the task is finished
- **Streaming mode (`tasks/sendSubscribe`)**: Streams partial results in real-time using Server-Sent Events (SSE)

Agent code remains the same in both modes - the framework automatically handles buffering or streaming based on the API endpoint used.

### Try the Streaming Demo

```bash
yarn streaming-demo
```

This interactive demo shows how the same agent code produces different outputs depending on whether streaming is enabled.

### Implementing Streaming in Your Agent

Your agent can use these methods to emit content:

```typescript
// Send progress updates
ctx.progress({ state: 'working', timestamp: new Date().toISOString() });

// Send partial content
ctx.reply([{ type: 'text', text: 'Partial content...' }], { 
  append: true,  // Append to previous chunk
  lastChunk: false // Not the last chunk
});

// Complete the task
ctx.complete({
  state: 'completed',
  timestamp: new Date().toISOString()
});
```

The framework automatically buffers or streams these updates based on the client's request type.

## Development

(Add instructions for developing agents using the framework once implemented)

## ESM & TypeScript Setup

This monorepo uses **ECMAScript Modules (ESM)** and modern TypeScript for all packages and apps. This ensures compatibility with the latest Node.js features, enables dynamic imports, and future-proofs the codebase.

### Why ESM?
- Native support in Node.js 20+ (and all LTS versions)
- Enables dynamic `import()` (required for plugin/agent loading)
- Aligns with the JavaScript ecosystem's direction
- Better compatibility with modern tooling

### Key Configuration
- All `package.json` files include: `"type": "module"`
- All `tsconfig.json` files use: `"module": "nodenext"`, `"moduleResolution": "nodenext"`
- All relative imports in ESM code use explicit `.js` extensions (e.g., `import { x } from './foo.js'`)
- Each package's `package.json` sets `"main"` and `"exports"` to the ESM entrypoint (e.g., `dist/index.js` or `dist/src/YourModule.js`)

### Adding New Packages/Apps
1. Add `"type": "module"` to `package.json`
2. Use `"module": "nodenext"` and `"moduleResolution": "nodenext"` in `tsconfig.json`
3. Use explicit `.js` extensions in all relative imports
4. Set the correct ESM entrypoint in `main` and `exports` fields

### Troubleshooting
- **Cannot find package ... imported from ...**: Ensure the package is built and linked, and the entrypoint is correct in `package.json`.
- **Relative import paths need explicit file extensions**: Add `.js` to all relative imports in ESM code.
- **Default/CommonJS export issues**: Use `export`/`import` syntax everywhere; avoid `module.exports` or `require()`.

For more, see the [Node.js ESM docs](https://nodejs.org/api/esm.html) and [TypeScript ESM docs](https://www.typescriptlang.org/docs/handbook/esm-node.html).

## Using CallAgent as a Library 📚

This project can be used as a **consumable library** in your applications, not just for framework development. Here are the main usage patterns:

### 🚀 Quick Start for Library Users

#### 1. Install the Core Package
```bash
npm install @a2arium/callagent-core
# Optional: For database persistence
npm install @a2arium/callagent-memory-sql
```

#### 2. Set Up Your Database (if using SQL memory)
```bash
# Option A: Create a .env file in your project root (recommended)
# DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

# Option B: Export as environment variable
export DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

# Set up the database schema
npx @a2arium/callagent-memory-sql setup
```

#### 2a. View Your Database (optional)
```bash
# Open Prisma Studio to view/edit your data
npx @a2arium/callagent-memory-sql studio

# Opens at http://localhost:5555
# Use Ctrl+C to stop
```

#### 3. Create Your First Agent
```typescript
// my-agent.ts
import { createAgent } from '@a2arium/callagent-core';

const manifest = {
  name: 'my-agent',
  version: '1.0.0',
  description: 'My custom agent',
  inputs: {
    message: { type: 'string', required: true }
  },
  outputs: {
    response: { type: 'string' }
  }
};

export default createAgent(manifest, {
  async handleTask(ctx) {
    const { message } = ctx.input;
    
    // Use memory
    await ctx.memory.semantic.set('last_message', message);
    
    // Use LLM
    const response = await ctx.llm.call({
      messages: [{ role: 'user', content: `Respond to: ${message}` }]
    });
    
    return {
      response: response.content
    };
  }
});
```

#### 4. Run Your Agent
```typescript
// main.ts
import myAgent from './my-agent.js';

const result = await myAgent.execute({ 
  message: "Hello, agent!" 
});

console.log(result.response);
```

### 💾 Database Configuration Options

The library supports multiple database configuration approaches:

#### Option 1: Environment Variables (Recommended)
```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"
```
```typescript
// The library automatically uses DATABASE_URL or MEMORY_DATABASE_URL
const agent = createAgent(manifest, handler);
```

#### Option 2: Direct Database URL
```typescript
import { createAgent } from '@a2arium/callagent-core';

const agent = createAgent(manifest, handler, {
  memory: {
    database: {
      url: "postgresql://user:pass@localhost:5432/yourdb"
    }
  }
});
```

#### Option 3: Pre-configured Prisma Client
```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  // Your custom Prisma configuration
});

const agent = createAgent(manifest, handler, {
  memory: {
    database: {
      prismaClient: prisma
    }
  }
});
```

#### Option 4: Custom Memory Adapters
```typescript
import { createAgent } from '@a2arium/callagent-core';
import { MyCustomMemoryAdapter } from './my-adapter.js';

const agent = createAgent(manifest, handler, {
  memory: {
    adapters: {
      semantic: new MyCustomMemoryAdapter(),
      // working: new MyCustomWorkingMemoryAdapter()
    }
  }
});
```

### 🔧 Advanced Configuration

#### Full Configuration Example
```typescript
import { createAgent } from '@a2arium/callagent-core';
import { PrismaClient } from '@prisma/client';

const agent = createAgent(manifest, handler, {
  memory: {
    database: {
      url: process.env.DATABASE_URL,
      // OR prismaClient: customPrismaClient
    },
    // Custom adapters override database config
    adapters: {
      // semantic: customSemanticAdapter,
      // working: customWorkingAdapter
    }
  },
  // Other configuration options...
});
```

#### Multi-Agent Systems
```typescript
// coordinator.ts
import { createAgent } from '@a2arium/callagent-core';

const coordinator = createAgent({
  name: 'coordinator',
  dependencies: { agents: ['data-processor', 'report-generator'] }
}, {
  async handleTask(ctx) {
    // Call other agents
    const data = await ctx.sendTaskToAgent('data-processor', { 
      source: ctx.input.dataSource 
    });
    
    const report = await ctx.sendTaskToAgent('report-generator', { 
      data: data.processed 
    });
    
    return { report: report.content };
  }
});
```

### 🏗️ Production Deployment

For production deployments, the library is designed to be **environment-agnostic**:

- ✅ **Works with any database setup** (your choice of connection management)
- ✅ **No file system dependencies** (no `.env` file requirements)
- ✅ **Container-friendly** (Docker, Kubernetes, etc.)
- ✅ **Cloud-ready** (works with managed databases, secret managers)

Example production setup:
```typescript
// In production, use your deployment platform's configuration
const agent = createAgent(manifest, handler, {
  memory: {
    database: {
      // Read from your secret manager, env vars, config service, etc.
      url: await getSecretValue('DATABASE_URL')
    }
  }
});
```

### 📖 Package Documentation

- **[@a2arium/callagent-core](packages/core/README.md)** - Core framework and agent creation
- **[@a2arium/callagent-memory-sql](packages/memory-sql/README.md)** - SQL-based memory persistence  
- **[@a2arium/callagent-types](packages/types/README.md)** - Shared TypeScript types
- **[@a2arium/callagent-utils](packages/utils/README.md)** - Shared utilities

---

## Framework Development 🛠️

The following sections are for **developing the CallAgent framework itself**, not for using it as a library.

### Environment Variables & Development

For framework developers, this monorepo uses [dotenv](https://www.npmjs.com/package/dotenv) to load environment variables from a `.env` file at the project root during development.

#### Development Best Practices
- Place all shared environment variables in the root `.env` file
- The sync script automatically propagates `.env` to packages that need it (like `packages/memory-sql`)
- In production library usage, consumers manage their own environment variables

#### Environment Sync Behavior
The `scripts/sync-dotenv.cjs` script automatically detects the environment:
- ✅ **Framework Development**: Syncs `.env` file to packages
- ✅ **Library Consumer**: Skips sync entirely (safe for production)
- ✅ **CI/Production**: Skips sync (environment-aware)

#### Troubleshooting Development Setup
- If you see errors about missing environment variables during framework development, ensure `.env` exists in the project root
- For library consumers: manage environment variables using your deployment platform's standard approach 