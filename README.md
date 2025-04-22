# Minimal AI Agents Framework Core

This repository contains the minimal viable core for the AI Agents Framework, as specified in the design document.

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

## Development

(Add instructions for developing agents using the framework once implemented) 