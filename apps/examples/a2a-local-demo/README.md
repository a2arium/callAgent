# A2A Local Demo - Multi-Agent Workflow

This example demonstrates agent-to-agent (A2A) communication with memory context transfer using the callAgent framework.

## Architecture

The demo includes three agents that work together:

1. **Coordinator Agent** - Orchestrates the workflow, delegates tasks to specialist agents
2. **Data Analysis Agent** - Specializes in data processing and metrics analysis  
3. **Reporting Agent** - Generates reports from analysis data

## Features Demonstrated

- **Multi-Agent Coordination**: Coordinator delegates tasks to specialist agents
- **Memory Context Transfer**: Working memory (goals, thoughts, decisions, variables) is inherited
- **Semantic Memory Sharing**: Long-term knowledge is shared between agents
- **MLO Pipeline Integration**: All memory operations flow through the 6-stage pipeline
- **Tenant Isolation**: Each workflow maintains proper tenant boundaries
- **Decision Tracking**: Decisions made by one agent are available to others
- **Variable Persistence**: Working variables are shared across agent boundaries

## Memory Inheritance

When the coordinator calls child agents with `inheritWorkingMemory: true`:

- **Goals**: Child agents inherit the main workflow goal
- **Thoughts**: Previous reasoning chain is available
- **Decisions**: Prior decisions influence child agent behavior  
- **Variables**: Workflow metadata is shared (workflowId, priority, etc.)

When called with `inheritMemory: true`:

- **Semantic Memory**: Facts and structured data are shared
- **Episodic Memory**: Event history is available
- **Analysis Results**: Outputs from one agent become inputs to another

## Running the Demo

```bash
# Install dependencies
yarn install

# Run the demo
yarn demo
```

## Expected Output

The demo will show:

1. Coordinator setting up workflow context
2. Data Analysis Agent inheriting context and processing metrics
3. Reporting Agent inheriting both contexts and generating final report
4. Memory transfer logs showing context inheritance
5. Final workflow summary with complete audit trail

## Architecture Benefits

- **Separation of Concerns**: Each agent specializes in one domain
- **Context Continuity**: Full context flows between agents
- **Scalability**: Easy to add new specialist agents
- **Observability**: Complete audit trail of multi-agent workflows
- **Reusability**: Agents can be combined in different workflows 