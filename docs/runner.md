# Agent Runner

The Agent Runner is a versatile CLI tool that supports both streaming and non-streaming modes for agent execution. It allows agents to provide real-time updates and partial results as they become available, or to operate in traditional buffered mode.

## Features

- Supports both streaming and non-streaming modes
- Multiple output formats: console, JSON, and SSE (Server-Sent Events)
- File output capabilities for logging or debugging
- Built-in event listening for streaming events
- Compatible with existing agents

## Usage

### Command Line Interface

You can run the agent runner using the following command:

```
yarn run-agent <path-to-agent-module> [json-input] [options]
```

For example:

```bash
# Run the hello agent with streaming enabled
yarn run-agent examples/hello-agent/AgentModule.ts '{"name":"World"}' --stream

# Run the LLM agent with JSON output format
yarn run-agent examples/llm-agent/AgentModule.ts '{"query":"Tell me a joke"}' --stream --format=json

# Run the streaming demo agent with SSE output format
yarn run-agent examples/streaming-agent/AgentModule.ts '{"query":"What is AI?"}' --stream --format=sse

# Write output to a file
yarn run-agent examples/streaming-agent/AgentModule.ts '{"query":"Tell me a story"}' --stream --output=output.txt
```

### Options

- `--stream`: Enable streaming mode (default: false)
- `--format=<format>`: Output format, one of 'console', 'json', or 'sse' (default: 'console')
- `--output=<file>`: Write output to the specified file as well as stdout

### Predefined Scripts

For convenience, several predefined scripts are available in package.json:

```bash
# Run the demo agent with console output
yarn run-agent-demo

# Run the demo agent with JSON output
yarn run-agent-demo-json

# Run the demo agent with SSE output
yarn run-agent-demo-sse
```

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

See the `examples/streaming-agent/AgentModule.ts` for a complete example.

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
{"type":"artifact","name":"response","index":0,"append":true,"lastChunk":false,"content":"\"Tell me about AI agents\". "}
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
- `examples/streaming-agent/AgentModule.ts`: Example agent with streaming capabilities

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
*   `ctx.logger`: Provides access to a structured logger (debug, info, warn, error).

### Recording Usage Data  

The framework automatically aggregates or stores the recorded usage data. When the task finishes (via `ctx.complete` or `ctx.fail`), the framework attaches the recorded usage information to the `metadata` field of the final `TaskStatus` object sent in the concluding `TaskStatusUpdateEvent`. This ensures usage data is consistently reported without cluttering the main message or artifact parts. 

You can also manually record usage data using the `ctx.recordUsage` method:

```typescript
ctx.recordUsage(usage: Usage): void;
```
 