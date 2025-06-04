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

# Minimal AI Agents Framework Core

This repository contains the minimal viable core for the AI Agents Framework, as specified in the design document.

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
// agent.json
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
});
```

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

## Environment Variables & dotenv

This monorepo uses [dotenv](https://www.npmjs.com/package/dotenv) to load environment variables from a `.env` file at the project root. This ensures all packages and apps have access to required configuration (e.g., database URLs) during local development and CI.

### Best Practices
- Place all shared environment variables in the root `.env` file.
- The runner and any entrypoint scripts automatically load `.env` via `dotenv`.
- For tools like Prisma that require `.env` in a package directory, a symlink or copy is created as needed.
- In CI, ensure the `.env` file is present or variables are set in the environment.

### Automating .env Propagation
To avoid manual copying, a postinstall script can symlink or copy the root `.env` to all packages that need it (e.g., `packages/memory-sql`).

Example (add to root `package.json`):
```json
"scripts": {
  "postinstall": "node scripts/sync-dotenv.js"
}
```

See the `scripts/sync-dotenv.js` utility for details.

### Troubleshooting
- If you see errors about missing environment variables, ensure `.env` is present in the root and/or the relevant package directory.
- For local development, restart your shell after editing `.env`. 