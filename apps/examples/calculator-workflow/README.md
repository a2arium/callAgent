# Multi-Agent Calculator Workflow

This example demonstrates advanced agent collaboration using the callAgent framework's **Approach 2** (multiple agents in one folder). Four specialized agents work together to solve mathematical expressions through intelligent delegation and coordination.

## Architecture

The demo includes four agents that collaborate to solve mathematical expressions:

1. **🎯 Coordinator Agent** - Orchestrates the calculation, parses expressions, and delegates operations
2. **➕ Arithmetic Agent** - Handles addition operations, delegates subtraction to the subtraction agent
3. **✖️ Multiplication Agent** - Handles multiplication and division operations independently
4. **➖ Subtraction Agent** - Specializes in subtraction operations

## Agent Dependencies

```
Coordinator Agent
├── Arithmetic Agent
│   └── Subtraction Agent
└── Multiplication Agent
```

## How It Works

For the expression `5 * 2 + 3 - 1`:

1. **Coordinator** parses the expression and identifies operations
2. **Coordinator** sends `5 * 2` to **Multiplication Agent** → gets `10`
3. **Coordinator** sends `10 + 3 - 1` to **Arithmetic Agent**
4. **Arithmetic Agent** processes `10 + 3 = 13` itself
5. **Arithmetic Agent** delegates `13 - 1` to **Subtraction Agent** → gets `12`
6. **Arithmetic Agent** returns `12` to **Coordinator**
7. **Coordinator** produces final result: `12`

## Features Demonstrated

- **Multi-Agent Coordination**: Coordinator orchestrates complex workflows
- **Automatic Dependency Resolution**: All agents discovered and loaded automatically
- **Specialized Delegation**: Each agent has specific responsibilities
- **Agent-to-Agent Communication**: Seamless A2A calls between agents
- **Enhanced Discovery**: Multiple agents in one folder automatically discovered
- **Operation Precedence**: Proper mathematical order of operations
- **Error Handling**: Graceful error propagation across agents

## Directory Structure

```
apps/examples/calculator-workflow/
├── CoordinatorAgent.ts           # Main orchestrator (name matches folder)
├── ArithmeticAgent.ts           # Addition + delegation (inline manifest)
├── MultiplicationAgent.ts       # Multiplication & division (inline manifest)
├── SubtractionAgent.ts          # Subtraction specialist (inline manifest)
├── calculator-workflow.json     # ONLY for main agent (optional)
├── subtraction-agent.json       # Legacy file (will be removed)
├── package.json
├── tsconfig.json
└── dist/ (built files)
```

**Important:** In multi-agent folders, only the main agent (whose name matches the folder) can have an external JSON manifest. All other agents must use inline manifests.

## Running the Demo

### 1. Build the Agents

```bash
cd apps/examples/calculator-workflow
yarn install
yarn build
```

### 2. Run Calculations

Use the CLI runner to execute calculations:

```bash
# Basic example (from the workflow directory)
yarn run-agent dist/CoordinatorAgent.js '{"expression": "5 * 2 + 3 - 1"}'

# Or from the repo root
yarn run-agent apps/examples/calculator-workflow/dist/CoordinatorAgent.js '{"expression": "5 * 2 + 3 - 1"}'

# Quick test
yarn test
```

### 3. Try Different Expressions

```bash
# Simple multiplication and addition
yarn run-agent dist/CoordinatorAgent.js '{"expression": "10 / 2 + 5"}'

# Complex expression with all operations
yarn run-agent dist/CoordinatorAgent.js '{"expression": "3 + 4 * 2 - 1"}'

# Multiple operations
yarn run-agent dist/CoordinatorAgent.js '{"expression": "20 - 5 + 2 * 3"}'

# Division and subtraction
yarn run-agent dist/CoordinatorAgent.js '{"expression": "8 / 4 - 1"}'
```

## Expected Output

For `5 * 2 + 3 - 1`:

```
🧮 Coordinator: Starting calculation for "5 * 2 + 3 - 1"
✖️ Multiplication Agent: Processing "5 * 2"
✖️ Multiplication Agent: 5 * 2 = 10
✅ Multiplication Agent: Result = 10
➕ Arithmetic Agent: Processing "10 + 3 - 1"
➕ Arithmetic Agent: 10 + 3 = 13
➖ Arithmetic Agent: Delegating "13 - 1" to subtraction-agent
➖ Subtraction Agent: Processing "13 - 1"
➖ Subtraction Agent: 13 - 1 = 12
✅ Subtraction Agent: Result = 12
✅ Arithmetic Agent: Received 12 from subtraction-agent
✅ Arithmetic Agent: Final result = 12
✅ Coordinator: Final result = 12
📋 Calculation steps:
  1. Coordinator: Parsed expression into tokens: [5,"*",2,"+",3,"-",1]
  2. Coordinator: Sending "5 * 2" to multiplication-agent
  3. Coordinator: Received 10 from multiplication-agent
  4. Coordinator: Sending "10 + 3 - 1" to arithmetic-agent
  5. Coordinator: Received 12 from arithmetic-agent

{
  "result": 12,
  "steps": [...],
  "expression": "5 * 2 + 3 - 1"
}
```

## Agent Specialization

### Coordinator Agent
- Parses mathematical expressions into tokens
- Handles operator precedence (multiplication/division before addition/subtraction)
- Delegates operations to appropriate specialist agents
- Assembles final results

### Arithmetic Agent
- Performs addition operations directly
- Delegates all subtraction operations to Subtraction Agent
- Processes left-to-right evaluation for addition/subtraction chains

### Multiplication Agent
- Handles multiplication (`*`) operations
- Handles division (`/`) operations
- Includes division-by-zero error handling
- Works independently without dependencies

### Subtraction Agent
- Specializes exclusively in subtraction operations
- Simple, focused responsibility
- Demonstrates fine-grained agent specialization

## Automatic Discovery

This demo showcases the **enhanced discovery system**:

- **Multiple agents in one folder** are automatically discovered
- **Filename patterns** like `*Agent.ts` are recognized
- **Agent names** are inferred from filenames (`CoordinatorAgent.ts` → `calculator-workflow`)
- **Main agent name MUST match folder name** (`calculator-workflow`)
- **Only inline manifests** allowed for dependent agents (no external JSON files)
- **Dependencies** are automatically resolved and loaded in correct order

## Dependency Resolution

The CLI runner automatically:

1. **Discovers** all 4 agents in the folder
2. **Resolves** the dependency graph:
   ```
   subtraction-agent (no deps)
   multiplication-agent (no deps)
   arithmetic-agent (depends on subtraction-agent)
   calculator-workflow (depends on arithmetic-agent, multiplication-agent)
   ```
3. **Loads** agents in dependency order
4. **Registers** all agents for A2A communication

## Error Handling

The system handles various error conditions:

```bash
# Division by zero
yarn run-agent dist/CoordinatorAgent.js '{"expression": "5 / 0"}'

# Invalid expression
yarn run-agent dist/CoordinatorAgent.js '{"expression": "5 +"}'

# Unsupported operations
yarn run-agent dist/CoordinatorAgent.js '{"expression": "5 ^ 2"}'
```

## Architecture Benefits

- **Separation of Concerns**: Each agent has a single, clear responsibility
- **Scalability**: Easy to add new operation types (e.g., exponentiation agent)
- **Maintainability**: Changes to one operation don't affect others
- **Testability**: Each agent can be tested independently
- **Reusability**: Agents can be used in different mathematical contexts
- **Observability**: Complete audit trail of all operations and delegations

## Extending the Demo

You can easily extend this demo by:

1. **Adding new agents** (e.g., `ExponentiationAgent.ts` + `exponentiation-agent.json`)
2. **Supporting parentheses** in the coordinator's parsing logic
3. **Adding more complex operations** (square root, trigonometry, etc.)
4. **Implementing caching** for repeated calculations
5. **Adding validation** for mathematical expressions

This demonstrates the power and flexibility of the callAgent framework's multi-agent architecture! 