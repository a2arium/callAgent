# Agent Dependencies Documentation

The callAgent framework provides a powerful agent dependency system that automatically resolves and loads dependent agents for A2A (Agent-to-Agent) communication.

## Quick Start

### Basic Usage

```bash
# Run agent with automatic dependency resolution (default)
yarn run-agent apps/examples/hello-to-llm-demo/dist/AgentModule.js '{}'

# Disable dependency resolution if needed
yarn run-agent apps/examples/hello-to-llm-demo/dist/AgentModule.js '{}' --no-resolve-deps
```

### Creating an Agent with Dependencies

```typescript
// agent.json
{
  "name": "hello-to-llm-agent",
  "version": "1.0.0",
  "description": "Demonstrates A2A communication via dependencies",
  "dependencies": {
    "agents": ["hello-agent"]
  }
}

// AgentModule.ts
import { createAgent } from '@callagent/core';

export default createAgent({
  async handleTask(ctx) {
    // Call dependent agent via A2A
    const result = await ctx.sendTaskToAgent('hello-agent', {
      name: 'A2A Demo User'
    });
    
    return { success: true, dependencyResult: result };
  }
}, import.meta.url);
```

## Agent Organization Approaches

The framework supports **two flexible approaches** for organizing your agents, both with **automatic discovery**:

### Approach 1: Separate Folders (Recommended for reusable agents)

Each agent lives in its own folder with its own manifest:

```
apps/examples/
├── hello-agent/
│   ├── AgentModule.ts
│   ├── agent.json
│   └── dist/
│       └── AgentModule.js
├── data-analysis-agent/
│   ├── AgentModule.ts
│   ├── agent.json
│   └── dist/
│       └── AgentModule.js
└── coordinator-agent/
    ├── AgentModule.ts
    ├── agent.json
    └── dist/
        └── AgentModule.js
```

**Benefits:**
- Clear separation of concerns
- Independent versioning and deployment
- Easier to maintain and test
- Perfect for reusable agent libraries

### Approach 2: Multiple Agents in One Folder (Great for workflows)

Multiple related agents can live together in a single folder:

```
apps/examples/my-workflow/
├── CoordinatorAgent.ts
├── DataAnalysisAgent.ts
├── ReportingAgent.ts
├── coordinator-agent.json
├── data-analysis-agent.json
├── reporting-agent.json
├── package.json
└── dist/
    ├── CoordinatorAgent.js
    ├── DataAnalysisAgent.js
    └── ReportingAgent.js
```

**Benefits:**
- All related agents in one place
- Shared dependencies and build process
- Easier for tightly coupled workflows
- Simplified project structure for demos

## Enhanced Discovery System

The framework automatically detects agents using both approaches:

### Traditional Discovery (Approach 1)
1. Scans directories in search paths
2. Uses folder name as agent name
3. Looks for `AgentModule.js` and `agent.json`

### Enhanced Discovery (Approach 2)
1. Scans for agent files matching patterns:
   - `*Agent.js/ts` (e.g., `DataAnalysisAgent.ts`)
   - `AgentModule*.js/ts`
   - `*-agent.js/ts`
2. Converts filenames to agent names:
   - `DataAnalysisAgent.ts` → `data-analysis-agent`
   - `coordinator-agent.ts` → `coordinator-agent`
3. Finds corresponding manifest files

### Discovery Priority
1. **Traditional first**: If folder structure matches, uses traditional approach
2. **Enhanced fallback**: If traditional fails, scans for multiple agents
3. **Backward compatible**: Existing projects continue working unchanged

## Complete Multi-Agent Workflow Example

Here's a complete example using Approach 2 (multiple agents in one folder):

### Directory Structure
```
apps/examples/business-workflow/
├── CoordinatorAgent.ts
├── DataAnalysisAgent.ts
├── ReportingAgent.ts
├── coordinator-agent.json
├── data-analysis-agent.json
├── reporting-agent.json
└── dist/ (built files)
```

### Agent Manifests

```json
// coordinator-agent.json
{
  "name": "coordinator-agent",
  "version": "1.0.0",
  "description": "Orchestrates business workflow",
  "dependencies": {
    "agents": ["data-analysis-agent", "reporting-agent"]
  }
}

// data-analysis-agent.json
{
  "name": "data-analysis-agent", 
  "version": "1.0.0",
  "description": "Analyzes business data"
}

// reporting-agent.json
{
  "name": "reporting-agent",
  "version": "1.0.0", 
  "description": "Generates business reports"
}
```

### Agent Implementations

```typescript
// CoordinatorAgent.ts
import { createAgent } from '@callagent/core';

export default createAgent({
  async handleTask(ctx) {
    await ctx.reply('🎯 Starting business workflow...');
    
    // Call data analysis agent
    const analysisResult = await ctx.sendTaskToAgent('data-analysis-agent', {
      dataset: 'Q4-sales-data',
      metrics: ['revenue', 'growth', 'conversion']
    });
    
    // Call reporting agent with analysis results
    const report = await ctx.sendTaskToAgent('reporting-agent', {
      analysis: analysisResult,
      format: 'executive-summary'
    });
    
    return {
      workflow: 'completed',
      analysis: analysisResult,
      report: report
    };
  }
}, import.meta.url);

// DataAnalysisAgent.ts
import { createAgent } from '@callagent/core';

export default createAgent({
  async handleTask(ctx) {
    const { dataset, metrics } = ctx.task.input as any;
    
    await ctx.reply(`📊 Analyzing ${dataset} for metrics: ${metrics.join(', ')}`);
    
    // Simulate data analysis
    const results = {
      dataset,
      metrics: metrics.map((metric: string) => ({
        name: metric,
        value: Math.random() * 100,
        trend: Math.random() > 0.5 ? 'up' : 'down'
      }))
    };
    
    return results;
  }
}, import.meta.url);

// ReportingAgent.ts
import { createAgent } from '@callagent/core';

export default createAgent({
  async handleTask(ctx) {
    const { analysis, format } = ctx.task.input as any;
    
    await ctx.reply(`📋 Generating ${format} report...`);
    
    const report = {
      title: `Business Analysis Report - ${analysis.dataset}`,
      format,
      summary: `Analyzed ${analysis.metrics.length} key metrics`,
      metrics: analysis.metrics,
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }
}, import.meta.url);
```

### Running the Workflow

```bash
# Build the agents
yarn build

# Run the coordinator (dependencies auto-resolved)
yarn run-agent apps/examples/business-workflow/dist/CoordinatorAgent.js '{}'
```

**Expected Output:**
```
🎯 Starting business workflow...
📊 Analyzing Q4-sales-data for metrics: revenue, growth, conversion
📋 Generating executive-summary report...
✅ Workflow completed with full analysis and report
```

## Manifest Format

### Complete Manifest Schema

```typescript
interface AgentManifest {
  name: string;                    // Required: Unique agent identifier
  version: string;                 // Required: Semantic version
  description?: string;            // Recommended: Human-readable description
  dependencies?: {
    agents?: string[];             // List of dependent agent names
  };
  memory?: {
    profile?: string;              // Memory profile: 'basic' | 'conversational' | 'advanced'
  };
  llm?: {
    provider?: string;             // LLM provider configuration
    model?: string;
  };
}
```

### Dependency Declaration Syntax

```json
{
  "dependencies": {
    "agents": [
      "hello-agent",              // Simple agent reference
      "data-analysis-agent",      // Another dependency
      "reporting-agent"           // Multiple dependencies supported
    ]
  }
}
```

### Inline Manifests (Alternative)

```typescript
export default createAgent({
  manifest: {
    name: 'inline-agent',
    version: '1.0.0',
    description: 'Agent with inline manifest',
    dependencies: {
      agents: ['hello-agent']
    }
  },
  async handleTask(ctx) {
    // Agent implementation
  }
}, import.meta.url);
```

## Dependency Resolution

### How Resolution Works

1. **Discovery**: System searches for agent files and manifests in standard locations
2. **Graph Building**: Creates dependency graph and detects circular dependencies
3. **Topological Sort**: Determines correct loading order
4. **Loading**: Loads agents in dependency order
5. **Registration**: Makes all agents available for A2A calls

### Loading Order

Agents are loaded in topological order to ensure dependencies are available:

```
Coordinator Agent
├── Data Analyzer Agent
│   └── Data Fetcher Agent    ← Loaded first
└── Report Generator Agent
    └── Data Fetcher Agent    ← Shared dependency (loaded once)
```

Loading order: `["data-fetcher-agent", "data-analyzer-agent", "report-generator-agent", "coordinator-agent"]`

### Error Handling

```typescript
// Missing Dependency
try {
  await runAgent('agent-with-missing-deps');
} catch (error) {
  // DependencyResolutionError: Dependency 'missing-agent' not found
}

// Circular Dependency
try {
  await runAgent('agent-with-circular-deps');
} catch (error) {
  // DependencyResolutionError: Circular dependency detected: agent-a -> agent-b -> agent-a
}
```

## Common Patterns

### 1. Linear Chain

```
UI Agent → Business Logic Agent → Data Access Agent
```

```json
// ui-agent/agent.json
{
  "name": "ui-agent",
  "dependencies": { "agents": ["business-logic-agent"] }
}

// business-logic-agent/agent.json
{
  "name": "business-logic-agent",
  "dependencies": { "agents": ["data-access-agent"] }
}
```

### 2. Fan-out Pattern

```
     Coordinator
    /     |     \
Data    Analysis  Report
Agent    Agent    Agent
```

```json
// coordinator-agent/agent.json
{
  "name": "coordinator-agent",
  "dependencies": {
    "agents": ["data-agent", "analysis-agent", "report-agent"]
  }
}
```

### 3. Diamond Dependencies

```
    Main Agent
   /          \
AgentA      AgentB
   \          /
   Shared Agent
```

```json
// main-agent/agent.json
{
  "name": "main-agent",
  "dependencies": { "agents": ["agent-a", "agent-b"] }
}

// agent-a/agent.json
{
  "name": "agent-a",
  "dependencies": { "agents": ["shared-agent"] }
}

// agent-b/agent.json  
{
  "name": "agent-b",
  "dependencies": { "agents": ["shared-agent"] }
}
```

## CLI Usage

### Command Options

```bash
# Basic usage with dependency resolution
yarn run-agent <agent-path> <input-json> [options]

# Options:
--resolve-deps     # Enable dependency resolution (default)
--no-resolve-deps  # Disable dependency resolution
--tenant=<id>      # Specify tenant context
--stream           # Enable streaming output
--format=json      # Output format: json, sse, console
```

### Examples

```bash
# Run with dependencies (default) - Approach 1
yarn run-agent apps/examples/hello-to-llm-demo/dist/AgentModule.js '{"name": "User"}'

# Run with dependencies - Approach 2 (multi-agent folder)
yarn run-agent apps/examples/business-workflow/dist/CoordinatorAgent.js '{}'

# Run without dependency resolution
yarn run-agent apps/examples/hello-agent/dist/AgentModule.js '{"name": "User"}' --no-resolve-deps

# Run with specific tenant
yarn run-agent apps/examples/business-workflow/dist/CoordinatorAgent.js '{}' --tenant=enterprise-123

# Run with streaming output
yarn run-agent apps/examples/coordinator-agent/dist/AgentModule.js '{}' --stream --format=json
```

## Advanced Features

### 1. Conditional Dependencies

Currently not supported, but you can implement conditional calls:

```typescript
export default createAgent({
  async handleTask(ctx) {
    const config = ctx.task.input as any;
    
    if (config.needsAnalysis) {
      const analysis = await ctx.sendTaskToAgent('analysis-agent', config);
      return { analysis };
    }
    
    return { message: 'No analysis needed' };
  }
});
```

### 2. Version Constraints

Currently not supported. All dependencies use latest available version.

### 3. Optional Dependencies

```typescript
export default createAgent({
  async handleTask(ctx) {
    try {
      const optional = await ctx.sendTaskToAgent('optional-agent', {});
      return { main: 'result', optional };
    } catch (error) {
      // Handle missing optional dependency
      return { main: 'result', optional: null };
    }
  }
});
```

## Troubleshooting

### Common Issues

#### 1. "Dependency not found"

```
DependencyResolutionError: Dependency 'missing-agent' not found for agent 'my-agent'
```

**Solutions:**
- Ensure dependency agent exists in `apps/examples/` or other search paths
- Check agent name spelling in manifest
- Verify agent has proper file structure (agent file + manifest)
- Run `yarn build` to ensure agent is compiled
- For multi-agent folders, ensure filename follows patterns (`*Agent.ts`, `*-agent.ts`)

#### 2. "Circular dependency detected"

```
DependencyResolutionError: Circular dependency detected: agent-a -> agent-b -> agent-a
```

**Solutions:**
- Review agent dependencies to break circular references
- Extract shared functionality into a common agent
- Redesign agent interaction patterns

#### 3. "Agent not registered"

```
Error: Agent 'target-agent' not found
```

**Solutions:**
- Enable dependency resolution with `--resolve-deps` (default)
- Check that target agent manifest is valid
- Verify agent is listed in dependencies
- For multi-agent folders, ensure agent files follow naming conventions

#### 4. "Agent file not discovered"

For multi-agent folders, ensure your files match these patterns:
- `*Agent.js/ts` (e.g., `DataAnalysisAgent.ts`)
- `AgentModule*.js/ts`
- `*-agent.js/ts`
- `agent.js/ts`
- `index.js/ts`

### Debugging Dependency Resolution

```bash
# Enable debug logging
LOG_LEVEL=debug yarn run-agent <agent-path> <input>

# Look for these log messages:
# [DependencyResolver] Starting dependency resolution
# [DependencyResolver] Loading order: [...]
# [AgentDiscovery] Found agent file...
# [AgentDiscovery] Enhanced discovery found multiple agents...
# [ManifestValidator] Manifest validation passed...
```

### Debugging A2A Communication

```bash
# Enable A2A debug logging
LOG_LEVEL=debug yarn run-agent <agent-path> <input>

# Look for these log messages:
# [A2AService] Sending task to agent...
# [A2AService] Agent found: ...
# [A2AService] Task completed successfully
```

## Architecture Notes

### Discovery Locations

The system searches for agents in these locations:
- `apps/examples/` (both single-agent folders and multi-agent folders)
- `packages/examples/` 
- `dist/apps/examples/` (compiled versions)
- `dist/packages/examples/`
- `.` (current directory)

### Agent File Patterns

The enhanced discovery recognizes these patterns:
- `AgentModule.js/ts` (traditional)
- `*Agent.js/ts` (e.g., `DataAnalysisAgent.ts`)
- `*-agent.js/ts` (e.g., `data-analysis-agent.ts`)
- `agent.js/ts`
- `index.js/ts`

### Filename to Agent Name Conversion

- `DataAnalysisAgent.ts` → `data-analysis-agent`
- `coordinator-agent.ts` → `coordinator-agent`
- `ReportingAgent.js` → `reporting-agent`

### Manifest Resolution Priority

1. **Inline manifests** (from `createAgent({ manifest: {...} })`)
2. **External files** (from `agent.json` files)
3. **Filename inference** (as fallback for agent naming)

### Agent Registration

All agents are registered in a global registry with:
- **Primary name** (from manifest)
- **Aliases** (auto-generated: kebab-case, without suffixes)
- **Fuzzy matching** (for convenience)

## Best Practices

### 1. Agent Design

- **Single Responsibility**: Each agent should have one clear purpose
- **Loose Coupling**: Minimize dependencies between agents
- **Error Handling**: Always handle A2A call failures gracefully

### 2. Organization Choice

**Use Separate Folders (Approach 1) when:**
- Building reusable agent libraries
- Agents have different lifecycles
- Independent versioning needed
- Following microservices architecture

**Use Multi-Agent Folders (Approach 2) when:**
- Building specific workflows or demos
- Agents are tightly coupled
- Shared dependencies and configuration
- Simplified project structure desired

### 3. Dependency Management

- **Minimize Dependencies**: Only declare necessary dependencies
- **Avoid Circular References**: Design hierarchical agent relationships
- **Document Dependencies**: Use clear descriptions in manifests
- **Consistent Naming**: Use kebab-case for agent names

### 4. File Naming

For multi-agent folders, use clear naming patterns:
- `CoordinatorAgent.ts` (PascalCase with Agent suffix)
- `data-analysis-agent.ts` (kebab-case with agent suffix)
- Match manifest names: `coordinator-agent.json`

### 5. Testing

```typescript
// Test agent with dependencies
import { createTestContext } from '@callagent/core/test-utils';

it('should call dependent agent', async () => {
  // Register dependency first
  const depAgent = createAgent({ /* ... */ });
  
  // Test main agent
  const ctx = await createTestContext();
  const result = await mainAgent.handleTask(ctx);
  
  expect(result.dependencyResult).toBeDefined();
});
```

### 6. Performance

- **Lazy Loading**: Dependencies loaded only when needed
- **Caching**: Agents loaded once and reused
- **Parallel Loading**: Independent dependencies loaded concurrently

## Migration Guide

### From Manual Registration to Automatic Discovery

**Before (Manual):**
```typescript
// Manual agent registration
PluginManager.registerAgent(dependencyAgent);
PluginManager.registerAgent(mainAgent);

// Manual execution
const result = await mainAgent.handleTask(ctx);
```

**After (Automatic):**
```json
// Add to agent.json
{
  "dependencies": {
    "agents": ["dependency-agent"]
  }
}
```

```bash
# Run with auto-resolution
yarn run-agent path/to/main-agent '{}'  # Dependencies loaded automatically
```

### From Single Approach to Flexible Organization

You can now choose the best organization for each use case:

```bash
# Approach 1: Separate folders (existing projects continue working)
yarn run-agent apps/examples/hello-agent/dist/AgentModule.js '{}'

# Approach 2: Multi-agent folders (new capability)
yarn run-agent apps/examples/my-workflow/dist/CoordinatorAgent.js '{}'
```

## Future Enhancements

- **Version Constraints**: Support for dependency version ranges
- **Optional Dependencies**: Mark dependencies as optional in manifest
- **Conditional Loading**: Load dependencies based on runtime conditions
- **Remote Dependencies**: Load agents from remote repositories
- **Dependency Caching**: Cache resolved dependency graphs
- **Hot Reloading**: Reload dependencies during development
- **Inline Manifest Discovery**: Extract agent names from inline manifests without importing 