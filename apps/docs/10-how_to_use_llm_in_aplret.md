# How-to: Use LLMs in APLRET

Use this guide when you need to make LLM calls from your agent. This covers configuration, calling patterns, structured output, streaming, tool calling, and MCP integration.

## Goal

- Set up LLM access for your agent.
- Call LLMs exclusively from Execution (the sole effect boundary).
- Get structured output using JSON Schema / Zod contracts.
- Use tool calling and MCP servers through the LLM.
- Follow the canonical data flow so LLM results enter cognition correctly.

## The key rule

**LLM calls are effects. Effects belong in Execution.**

LLM outputs may influence decisions only after they flow through:

```
Execution → Transition (observations) → inbox → Perception → Learning → MentalState
```

Policy may decide to use an LLM. Policy never calls an LLM.

This is APLRET Rule 3 (Single Effect Boundary) and Rule 5 (Sync, M-only Policy).

---

## Step 1: Configure LLM for your agent

The framework uses the `callllm` library under the hood, wrapped by `LLMCallerAdapter`. Configuration happens in `createAgent`:

```ts
import { createAgent } from '@a2arium/callagent-core';

export default createAgent({

  llmConfig: {
    provider: 'openai',                    // 'openai' | 'anthropic' | 'google' | etc
    modelAliasOrName: 'gpt-5',           // model name or alias
    systemPrompt: 'You are a helpful assistant.',
    historyMode: 'stateless',             // 'stateless' | 'dynamic' | 'full'
    // apiKey: process.env.OPENAI_API_KEY  // optional — falls back to env vars
  },

  // ... modules
}, import.meta.url);
```

### LLMConfig fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | LLM provider (`'openai'`, `'anthropic'`, `'google'`, etc.) |
| `modelAliasOrName` | `string` | Yes | Model identifier or alias |
| `systemPrompt` | `string` | No | System prompt (defaults to `'You are a helpful assistant.'`) |
| `apiKey` | `string` | No | API key — if omitted, callllm reads from env vars (`OPENAI_API_KEY`, etc.) |
| `historyMode` | `'stateless' \| 'dynamic' \| 'full'` | No | Conversation history management (see §History modes below) |
| `initialTools` | `ToolDefinition[]` | No | Tool definitions available to the LLM |
| `mcpServers` | `Record<string, { command, args?, env? }>` | No | MCP server configurations (see §MCP below) |
| `defaultSettings` | `Record<string, unknown>` | No | Default model settings (temperature, etc.) |
| `usageCallback` | `(usage: Usage) => void` | No | Custom usage callback (framework provides automatic tracking by default) |

### History modes

| Mode | Behavior | Use when |
|------|----------|----------|
| `'stateless'` | No conversation history retained between calls. Each call starts fresh. | Multi-turn APLRET agents where you control context explicitly through `MentalState`. Most agents should use this. |
| `'dynamic'` | Library manages a sliding window of recent messages. | Conversational agents where you want the LLM to remember recent turns naturally. |
| `'full'` | All messages retained. Default if unspecified. | Short-lived agents or debugging. Caution: unbounded growth. |

For most APLRET agents, use `'stateless'`. The loop already manages cognitive state through `MentalState` — you don't want the LLM library duplicating that.

---

## Step 2: Call the LLM from Execution

### Basic call

The LLM is available via `ctx.llm` inside Execution:

```ts
execution: async (intent, ctx) => {
  if (intent.kind === 'answer_with_llm') {
    const responses = await ctx.llm.call(intent.query);
    const text = responses[0]?.content ?? 'No response';

    await ctx.reply(text);

    return {
      action: { kind: 'internal', done: true },
      result: { status: 'ok', data: { text } }
    };
  }
  // ...
}
```

`ctx.llm.call()` returns `UniversalChatResponse<T>[]` — always an array. Large calls not fitting the context will be processed in chunks automatically and the array will contain all responses. If you expect a single response, the first element contains the first response.

### Response shape

```ts
type UniversalChatResponse<T = unknown> = {
  content: string;          // The text response
  role: string;             // Usually 'assistant'
  refusal?: string;         // If the model refused
  toolCalls?: ToolCall[];   // If the model wants to call tools
  metadata?: {
    usage?: Usage;          // Token counts and costs
  };
};
```

### Passing additional data

Use the `data` option to pass large payloads alongside the prompt:
It's a good practice to separate prompt and data in the call.
Data will be appended to the message context, and if needed, will be chunked automatically according to the model's context size.

```ts
const responses = await ctx.llm.call('Summarize this document:', {
  data: documentContent   // appended to the message context, chunked if needed
});
```

---

## Step 3: Structured output with contracts

Unless the expected result is purely free text, Execution MUST supply an explicit output contract.

### Use Zod (strongly recommended)

The `callllm` library handles the heavy lifting:

1. **Zod → JSON Schema conversion** — pass a Zod object directly, callllm converts it.
2. **Automatic validation** — callllm validates the LLM output against the schema and retries if needed.
3. **Automatic parsing** — no need to `JSON.parse()`. The parsed object is available in `response.contentObject`.

```ts
import { z } from 'zod';

const SentimentSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral'])
    .describe('The overall sentiment of the text'),
  confidence: z.number().min(0).max(1)
    .describe('How confident the model is in the assessment'),
  summary: z.string()
    .describe('A one-sentence summary of the text')
});

// In Execution:
execution: async (intent, ctx) => {
  const responses = await ctx.llm.call('Analyze the sentiment:', {
    data: userText,
    jsonSchema: { name: 'SentimentAnalysis', schema: SentimentSchema }
  });

  // contentObject is already parsed and validated by callllm
  const result = responses[0]?.contentObject;

  if (!result) {
    return {
      action: { kind: 'internal', done: false },
      result: {
        status: 'error',
        error: { code: 'schema_mismatch', message: 'LLM output did not match schema after retries' }
      }
    };
  }

  return {
    action: { kind: 'internal', done: false },
    result: { status: 'ok', data: result }
  };
}
```

### Tips for Zod schemas

- **Add `.describe()` to fields** — LLMs produce better structured output when fields have descriptions. This is the single most impactful thing you can do for output quality.
- **Keep schemas flat** — nested objects are fine, but deeply nested structures increase failure rates.
- **Use `z.enum()` for closed choices** — gives the LLM explicit options.
- **Use `z.array()` sparingly** — arrays of objects work well; arrays of arrays do not.

### Using raw JSON Schema (fallback)

If you cannot use Zod, you can pass a raw JSON Schema object. The same auto-validation and parsing applies:

```ts
const responses = await ctx.llm.call('Analyze the sentiment:', {
  data: userText,
  jsonSchema: {
    name: 'SentimentAnalysis',
    schema: {
      type: 'object',
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        summary: { type: 'string' }
      },
      required: ['sentiment', 'confidence', 'summary']
    }
  }
});

const result = responses[0]?.contentObject;
```

### Multi-chunk structured responses

When data is too large for a single context window, callllm splits it into chunks automatically. Each chunk produces its own response:

```ts
const responses = await ctx.llm.call('Extract all products:', {
  data: veryLargeHtml,
  jsonSchema: { name: 'ProductList', schema: ProductSchema }
});

// responses may contain multiple chunks
for (const response of responses) {
  const chunk = response.contentObject;
  // process each chunk...
}
```

### Contract failure handling

If the LLM output does not conform to the contract after automatic retries:

1. Execution MUST return a structured failure in `ExecResult` (do not throw across modules).
2. Transition MUST emit an observation that represents the failure.
3. Learning MUST write a durable fact that Policy can reason about (retry, repair, or ask user).

---

## Step 4: Streaming

Use `ctx.llm.stream()` when you want to emit tokens incrementally:

```ts
execution: async (intent, ctx) => {
  let fullText = '';

  for await (const chunk of ctx.llm.stream(intent.query)) {
    fullText += chunk.content || '';

    // Optionally relay chunks to the user in real time
    if (chunk.content) {
      await ctx.reply([{ type: 'text', text: chunk.content }]);
    }

    if (chunk.isComplete) break;
  }

  return {
    action: { kind: 'internal', done: true },
    result: { status: 'ok', data: { text: fullText } }
  };
}
```

### When to stream vs call

| Use `call` | Use `stream` |
|------------|-------------|
| Structured output (JSON Schema) | Free-text generation shown live to user |
| Short responses | Long-form content the user should see progressively |
| When you need to parse the complete response | When latency perception matters |

Most APLRET agents should use `call`. Streaming is primarily for user-facing text generation where you want to show progress.

---

## Step 5: Tool calling through the LLM

### Configuring tools

Define tools in `llmConfig.initialTools`:

```ts
llmConfig: {
  provider: 'openai',
  modelAliasOrName: 'gpt-4o',
  systemPrompt: 'You are a helpful assistant with access to tools.',
  initialTools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' }
        },
        required: ['location']
      },
      invoke: async (args: Record<string, unknown>) => {
        // Your tool implementation
        return { temperature: 22, condition: 'sunny' };
      }
    }
  ]
}
```

### Handling tool calls in Execution

When the LLM wants to call a tool, the response includes `toolCalls`:

```ts
execution: async (intent, ctx) => {
  const responses = await ctx.llm.call(intent.query);
  const response = responses[0];

  // If the LLM wants to call tools, the library handles it automatically
  // when tools have `invoke` functions. The final response contains the result.
  const text = response?.content ?? 'No response';

  return {
    action: { kind: 'internal', done: false },
    result: { status: 'ok', data: { text } }
  };
}
```

If you need manual tool result injection (advanced):

```ts
// After receiving a toolCall from the LLM
ctx.llm.addToolResult(toolCall.id, JSON.stringify(result), toolCall.name);
// Then call again to get the LLM's response incorporating the tool result
const followUp = await ctx.llm.call('Continue based on the tool result.');
```

---

## Step 6: MCP (Model Context Protocol) integration

### Configuring MCP servers

Add MCP servers in `llmConfig.mcpServers`. MCP tools become automatically available to the LLM alongside `initialTools`.

```ts
llmConfig: {
  provider: 'openai',
  modelAliasOrName: 'gpt-5',
  systemPrompt: 'You have access to filesystem tools.',
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/data'],
      env: {}
    },
    database: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', './data.db']
    }
  }
}
```

### Real-world example: browser automation with MCP

This example shows a production agent that uses an MCP browser server for web scraping:

```ts
// LLM config with MCP browser server (in a helper function)
function getLLMConfig(): LLMConfig {
  const mcpPath = process.env.BROWSER_USE_MCP_PATH;

  return {
    provider: 'openai',
    modelAliasOrName: 'gpt-5-mini',
    mcpServers: mcpPath ? {
      'browser-use': {
        command: `${mcpPath}venv/bin/python`,
        args: [`${mcpPath}server.py`],
        env: {
          BROWSER_USE_API_KEY: process.env.BROWSER_USE_API_KEY || '',
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
          BROWSER_USE_LOGGING: 'info'
        }
      }
    } : {}
  };
}
```

```ts
// In Execution — using MCP tool via requestTool (async/await pattern)
execution: async (intent, ctx) => {
  if (intent.kind === 'fetch_mcp') {
    const fetchContext = intent.data;

    if (!process.env.BROWSER_USE_MCP_PATH) {
      return {
        action: { kind: 'internal', done: false },
        result: {
          status: 'error',
          error: { code: 'MISSING_ENV', message: 'BROWSER_USE_MCP_PATH not set' }
        }
      };
    }

    const args = {
      url: fetchContext.url,
      task: buildNavigationPrompt(fetchContext, ''),
      site_config: fetchContext.siteConfig,
      output_model_schema: mcpOutputSchemaToJson(),
      session_id: fetchContext.siteConfig.site_id,
      env_vars: {
        BROWSER_USE_API_KEY: process.env.BROWSER_USE_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || ''
      }
    };

    // requestTool with namespace syntax: 'mcp:<server>.<tool>'
    const handle = await ctx.requestTool(
      'mcp:browser-use.navigate_and_extract',
      args,
      { awaitCompletion: false }
    );

    return {
      action: { kind: 'tool', token: handle.token },
      result: {
        status: 'ok',
        toolId: 'mcp:browser-use.navigate_and_extract',
        data: { kind: 'fetching_started', url: fetchContext.url }
      }
    };
  }
  // ...
}
```

The MCP tool executes asynchronously. Transition returns `{ kind: 'await_tool', token }` and the loop suspends. When the tool completes, the runtime injects a `tool.completed` observation into the next turn inbox.

### Direct MCP tool invocation

You can also bypass the async flow and call MCP tools directly (blocking):

```ts
execution: async (intent, ctx) => {
  // Call an MCP tool directly without going through requestTool
  const result = await ctx.llm.callMcpTool?.(
    'filesystem',                    // server name
    'read_file',                     // tool name
    { path: '/tmp/data/report.txt' } // arguments
  );

  return {
    action: { kind: 'internal', done: false },
    result: { status: 'ok', data: result }
  };
}
```

### Discovering MCP tool schemas

```ts
// Get available tools from an MCP server
const schemas = await ctx.llm.getMcpServerToolSchemas?.('filesystem');
```

---

## Step 7: Update LLM settings at runtime

Use `ctx.llm.updateSettings()` to adjust model parameters for a specific call pattern:

```ts
execution: async (intent, ctx) => {
  // Lower temperature for structured extraction
  ctx.llm.updateSettings({ temperature: 0 });

  const responses = await ctx.llm.call(intent.query, {
    jsonSchema: { name: 'ExtractedData', schema: mySchema }
  });

  // Restore normal temperature for creative tasks
  ctx.llm.updateSettings({ temperature: 0.7 });

  // ...
}
```

---

## Canonical APLRET data flow for LLM calls

Here is the full canonical path for any LLM call in the framework:

```
Turn N:
  Policy emits intent         → { kind: 'answer_with_llm', query: '...' }
  Shield checks budget/policy → { action: 'pass', intent }
  Execution calls ctx.llm     → receives UniversalChatResponse[]
  Transition packages result  → Observation[] into outgoing inbox

Turn N+1:
  env.inbox.current           ← contains the observation
  Perception normalizes       → extracts relevant fields
  Learning writes to M        → MentalState now has the LLM result
  Policy reads MentalState    → decides next action based on result
```

### Complete example: structured extraction with full loop

```ts
// === Agent definition ===

const ExtractionSchema = z.object({
  title: z.string(),
  price: z.number(),
  currency: z.string()
});

export default createAgent({

  llmConfig: {
    provider: 'openai',
    modelAliasOrName: 'gpt-4o',
    systemPrompt: 'You extract structured data from HTML.',
    historyMode: 'stateless'
  },

  perception: (env) => {
    // Look for extraction results from previous turn
    const extractionObs = env.inbox.current.find(o => o.kind === 'extraction.completed');
    if (extractionObs) {
      return { extractedData: extractionObs.payload };
    }

    // Look for user input with HTML to extract
    const userInput = env.inbox.current.find(o => o.source === 'user');
    return { html: userInput?.payload?.value?.html };
  },

  learning: (prev, _action, obs) => {
    const next = { ...prev, memory: { ...prev.memory } };

    if (obs.html) {
      // Store raw HTML for extraction
      next.memory.sensory = { ...next.memory.sensory, pendingHtml: obs.html };
    }

    if (obs.extractedData) {
      // Write extraction result to worldModel
      next.worldModel = { ...next.worldModel, ...obs.extractedData };
      next.memory.sensory = { ...next.memory.sensory, pendingHtml: undefined };
    }

    return next;
  },

  policy: (m) => {
    if (m.memory.sensory?.pendingHtml) {
      return { kind: 'answer_with_llm', query: 'Extract product data from this HTML.' };
    }
    if (m.worldModel?.title) {
      return { kind: 'complete', result: m.worldModel };
    }
    return { kind: 'prompt_user', prompt: 'Send me HTML to extract.' };
  },

  shield: (_m, intent) => ({ action: 'pass', intent }),

  execution: async (intent, ctx, _mem, m) => {
    if (intent.kind === 'answer_with_llm') {
      const responses = await ctx.llm.call(intent.query, {
        data: m.memory.sensory?.pendingHtml,
        jsonSchema: { name: 'ProductExtraction', schema: ExtractionSchema }
      });

      const result = responses[0]?.contentObject;

      if (!result) {
        return {
          action: { kind: 'internal', done: false },
          result: {
            status: 'error',
            error: { code: 'schema_mismatch', message: 'Extraction failed after retries' }
          }
        };
      }

      return {
        action: { kind: 'internal', done: false },
        result: { status: 'ok', data: result }
      };
    }

    if (intent.kind === 'prompt_user') {
      const handle = await ctx.requestInput(intent.prompt);
      return {
        action: { kind: 'ask_user', token: handle.token },
        result: { status: 'ok', data: { prompted: true } }
      };
    }

    if (intent.kind === 'complete') {
      await ctx.reply(JSON.stringify(intent.result, null, 2));
      return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: intent.result }
      };
    }

    return {
      action: { kind: 'internal', done: true },
      result: { status: 'ok', data: {} }
    };
  },

  transition: (_env, exec) => {
    if (exec.action.kind === 'ask_user') {
      return { kind: 'await_input', token: exec.action.token };
    }

    if (exec.result.status === 'ok' && exec.result.data?.title) {
      return {
        kind: 'continue',
        observations: [{
          source: 'internal',
          kind: 'extraction.completed',
          payload: exec.result.data
        }]
      };
    }

    if (exec.result.status === 'error') {
      return {
        kind: 'continue',
        observations: [{
          source: 'internal',
          kind: 'extraction.failed',
          payload: { error: exec.result.error }
        }]
      };
    }

    if (exec.action.kind === 'internal' && exec.action.done) {
      return { kind: 'complete', result: exec.result.data };
    }

    return { kind: 'continue', observations: [] };
  }
}, import.meta.url);
```

---

## Common mistakes

### 1. Calling LLM outside Execution

```ts
// ❌ WRONG: LLM in Policy
policy: async (m, mem, llm) => {
  const answer = await llm.call('Should I do X?');
  return answer.includes('yes') ? { kind: 'do_x' } : { kind: 'do_y' };
}

// ✅ RIGHT: Policy emits intent, Execution calls LLM
policy: (m) => {
  if (!m.memory.scratch?.evalResult) {
    return { kind: 'answer_with_llm', query: 'Should I do X?' };
  }
  return m.memory.scratch.evalResult === 'yes' ? { kind: 'do_x' } : { kind: 'do_y' };
}
```

### 2. Skipping the contract on structured output

```ts
// ❌ WRONG: No schema, trust raw LLM text
const res = await ctx.llm.call('Extract the price');
const price = parseInt(res[0]?.content ?? '0');

// ✅ RIGHT: Use Zod schema, read from contentObject
const PriceSchema = z.object({ price: z.number().describe('Price in cents') });
const res = await ctx.llm.call('Extract the price', {
  jsonSchema: { name: 'PriceExtraction', schema: PriceSchema }
});
const price = res[0]?.contentObject?.price;
```

### 3. Using LLM result in the same turn without Transition

```ts
// ❌ WRONG: Execution result used directly in Learning (same turn)
// This violates Turn Discipline — results must flow through Transition → inbox

// ✅ RIGHT: Transition emits observation, next turn Perception+Learning process it
```

### 4. Using `'full'` history mode in long-running agents

```ts
// ❌ WRONG: Unbounded history growth
llmConfig: { historyMode: 'full', ... }

// ✅ RIGHT: Stateless with explicit context in MentalState
llmConfig: { historyMode: 'stateless', ... }
```

---

## Usage tracking

LLM costs are tracked automatically. The framework records:

- Cost per call
- Token counts (input/output)
- Provider and model

Use `ctx.recordUsage()` for additional custom usage tracking. The adapter handles LLM cost tracking transparently.

---

## Quick reference

| Need | API | Notes |
|------|-----|-------|
| Basic LLM call | `ctx.llm.call(prompt)` | Returns `UniversalChatResponse[]` |
| With data payload | `ctx.llm.call(prompt, { data })` | Data appended to context, auto-chunked |
| Structured output (Zod) | `ctx.llm.call(prompt, { jsonSchema: { name, schema: ZodObject } })` | Use `response.contentObject` — auto-validated |
| Structured output (JSON) | `ctx.llm.call(prompt, { jsonSchema: { name, schema: jsonObj } })` | Same features, Zod preferred |
| Streaming | `ctx.llm.stream(prompt)` | `AsyncIterable<UniversalStreamResponse>` |
| Change settings | `ctx.llm.updateSettings({ temperature: 0 })` | Affects subsequent calls |
| Tool result | `ctx.llm.addToolResult(id, result, name)` | For manual tool loops |
| MCP tool (async) | `ctx.requestTool('mcp:server.tool', args)` | Returns token, loop suspends |
| MCP tool (blocking) | `ctx.llm.callMcpTool?.(server, tool, args)` | Bypasses LLM inference |
| MCP tool discovery | `ctx.llm.getMcpServerToolSchemas?.(server)` | Returns available tools |
| History management | `ctx.llm.clearHistory()` | Only if not `stateless` |
