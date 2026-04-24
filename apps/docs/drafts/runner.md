# Agent Runner

> Status: design draft.
> API shapes here may evolve; verify stable contracts in `apps/docs/0-aplret_contracts.md`.

The Agent Runner is a versatile CLI tool that supports both streaming and non-streaming modes for agent execution. It allows agents to provide real-time updates and partial results as they become available, or to operate in traditional buffered mode.

## Features

- Supports both streaming and non-streaming modes
- Multiple output formats: console, JSON, and SSE (Server-Sent Events)
- File output capabilities for logging or debugging
- Built-in event listening for streaming events
- Compatible with loop-first agents and auto-resume
- **Auto-resume support**: Handles `input-required` status and resumed turns
- **Adapter-agnostic memory system** (see [Memory System](./memory-system.md))
- **ESM-first, TypeScript-native** codebase
- **Environment management via dotenv**

## Usage

### Command Line Interface

You can run the agent runner using the following command:

```
yarn run-agent <path-to-agent-module> [json-input] [options]
```

For example:

```bash
# Run the hello agent with streaming enabled (compiled JS path)
yarn run-agent apps/examples/hello-agent/dist/AgentModule.js '{"name":"World"}' --stream

# Run the LLM agent with JSON output format
yarn run-agent apps/examples/llm-agent/dist/AgentModule.js '{"query":"Tell me a joke"}' --stream --format=json

# Run the streaming demo agent with SSE output format
yarn run-agent apps/examples/streaming-agent/dist/AgentModule.js '{"query":"What is AI?"}' --stream --format=sse

# Write output to a file
yarn run-agent apps/examples/streaming-agent/dist/AgentModule.js '{"query":"Tell me a story"}' --stream --output=output.txt
```

### Options

- `--stream`: Enable streaming mode (default: false)
- `--format=<format>`: Output format, one of 'console', 'json', or 'sse' (default: 'console')
- `--output=<file>`: Write output to the specified file as well as stdout

### Runtime note

- `yarn run-agent` uses compiled JS (`node .../dist/runnerCli.js`)
- For TypeScript source modules, use `yarn dev` or a Node TS loader (`tsx` / `--loader ts-node/esm`)

### Predefined Scripts

Script names vary per repository. Check your root `package.json` and run the commands that actually exist there.

```bash
# Example root scripts used in this repo
yarn run-agent "apps/examples/hello-agent/dist/AgentModule.js" '{"name":"World"}'
yarn dev "apps/examples/loop-agent-mini/AgentModule.ts" '{}'
```

## Auto-Resume Behavior

The runner supports loop-first agents with auto-resume capabilities:

### Non-Streaming Mode
- Agent runs until `input-required` status, then **exits cleanly**
- Prints session ID and token for manual input provision
- To continue: use `/tasks/{taskId}/input` API endpoint

```bash
yarn run-agent apps/examples/loop-agent-mini/dist/AgentModule.js '{}'
# Output:
# Status: input-required
# Session: task_abc123
# Token: input_xyz789
# (process exits)
```

### Streaming Mode  
- Agent runs until `input-required` status
- Emits status events in real-time
- **Process continues listening** for input events
- Auto-resumes when input is provided via API

```bash
yarn run-agent apps/examples/loop-agent-mini/dist/AgentModule.js '{}' --stream
# Output:
# Status: input-required, token: input_xyz789
# (process waits for input)
# 
# # After providing input via API:
# Status: working
# Status: completed
# (process exits)
```

### Providing Input to Resumed Agents

Use the `/tasks/{taskId}/input` endpoint:

```bash
# Get session/token from non-streaming run
curl -X POST http://localhost:3000/tasks/task_abc123/input \
  -H "Content-Type: application/json" \
  -d '{"token": "input_xyz789", "input": "user response"}'
```

## Environment Management

- The runner and agents load environment variables using [dotenv](https://github.com/motdotla/dotenv).
- Place your `.env` file at the project root or relevant app/package root.
- For adapters (e.g., SQL memory), ensure required variables like `MEMORY_DATABASE_URL` are set. See [Memory System](./memory-system.md) for details.

## Developing Streaming-Compatible Agents

To create an agent that takes advantage of streaming capabilities:

1. Use the `progress()` method with `TaskStatus` objects to update task status
2. Use the `reply()` method with appropriate options for streaming chunks
3. Set proper `append` and `lastChunk` flags when sending partial content

Here's a simple example:

```typescript
// Send content in chunks to demonstrate streaming
for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(
        [{ type: 'text', text: chunks[i] }],
        {
            artifactName: 'response',
            index: 0,
            append: i > 0,
            lastChunk: i === chunks.length - 1
        }
    );
    
    // Update progress percentage
    ctx.progress(Math.floor((i + 1) / chunks.length * 100), 
        `Processing chunk ${i + 1}/${chunks.length}`);
}
```

See `apps/examples/streaming-agent/AgentModule.ts` for a complete example.

## Understanding the Output

### Console Format (Default)

In console format, the runner formats output in a human-readable way:

```
Status: working
I'm starting to process your request about "Tell me about AI agents". 
Let me think about this for a moment...

AI agents are software entities that can perceive their environment...
[...]
Status: completed (FINAL)
```

### JSON Format

In JSON format, each event is emitted as a separate JSON object:

```json
{"type":"status","status":"working","timestamp":"2023-11-15T12:34:56.789Z","final":false}
{"type":"artifact","name":"response","index":0,"append":false,"lastChunk":false,"content":"I'm starting to process your request about "}
// ... more artifacts ...
{"type":"status","status":"completed","timestamp":"2023-11-15T12:35:01.123Z","final":true}
```

### SSE Format

In SSE format, events are formatted according to the Server-Sent Events protocol:

```
data: {"type":"status","status":"working","timestamp":"2023-11-15T12:34:56.789Z","final":false}

data: {"type":"artifact","name":"response","index":0,"append":false,"lastChunk":false,"content":"I'm starting to process your request about "}

// ... more events ...

data: {"type":"status","status":"completed","timestamp":"2023-11-15T12:35:01.123Z","final":true}
```

## Implementation Details

The runner uses the event bus and task channels to emit and listen for streaming events. It extends the standard task context with streaming capabilities using the `extendContextWithStreaming` function.

Key components:

- `streamingRunner.ts`: Core implementation of the streaming functionality
- `runnerCli.ts`: Command-line interface for the runner
- `apps/examples/streaming-agent/AgentModule.ts`: Example agent with streaming capabilities

## Backward Compatibility

For backward compatibility, the old `stream` commands are still available but now point to the new `run-agent` commands:

- `yarn stream` → `yarn run-agent`
- `yarn stream-agent` → `yarn run-agent-hello`
- `yarn stream-demo` → `yarn run-agent-demo`
- etc.

## Implementing Agents

When implementing an agent's `handleTask` function, you receive a `TaskContext` object (`ctx`). This object provides methods to interact with the framework, send replies, manage state, and access capabilities like LLM calls or tools.

### Key Context Methods

*   `ctx.reply(parts: MessagePart[])`: Sends content back to the client. Can be called multiple times for streaming.
*   `ctx.progress(status: TaskStatus)` or `ctx.progress(pct: number, msg?: string)`: Updates the task's progress or status.
*   `ctx.complete(pct?: number, status?: string)`: Marks the task as successfully completed. Attaches final status metadata.
*   `ctx.fail(error: unknown)`: Marks the task as failed. Attaches final status metadata.
*   `ctx.llm.call()` / `ctx.llm.stream()`: Makes calls to the configured Large Language Model.
*   `logger` (from `@a2arium/callagent-utils`): Centralized logger with automatic context enrichment (debug, info, warn, error). See [Logging Guidelines](../.cursor/rules/logging.mdc).
*   `ctx.memory`: Adapter-agnostic memory system, configured via DI/factory. See [Memory System](./memory-system.md).

### Recording Usage Data  

The framework automatically aggregates or stores the recorded usage data. When the task finishes (via `ctx.complete` or `ctx.fail`), the framework attaches the recorded usage information to the `metadata` field of the final `TaskStatus` object sent in the concluding `TaskStatusUpdateEvent`. This ensures usage data is consistently reported without cluttering the main message or artifact parts. 

You can also manually record usage data using the `ctx.recordUsage` method:

```typescript
ctx.recordUsage(usage: Usage): void;
```
 
## Contributor Notes

- All code and documentation should use ESM imports with `.js` extensions where required.
- Example and agent paths should use the new `apps/examples/` structure.
- Use [Mermaid](https://mermaid-js.github.io/) for diagrams in Markdown docs.
- Use [TypeDoc](https://typedoc.org/) for API documentation generation.
- See `.cursor/rules/documentation.mdc` for contributor documentation standards.
