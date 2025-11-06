# Chat Bridge for callagent

A multi-network chat integration layer for callagent. It normalizes inbound messages, routes start vs resume, maps agent replies and progress back to chat, and optionally publishes realtime events for WebSocket clients.

## Features

- Unified inbound message model across Telegram, Slack, and Web chat
- Start/resume routing with durable session mapping
- Idempotency hooks for duplicate deliveries
- Pluggable agent invocation: programmatic or JSON-RPC (Option B)
- Outbound text/media sending and typing indicators
- Optional realtime publishing (WS via Ably/Pusher/Supabase/AWS WS)
- Serverless friendly

## Core types

```ts
export type Network = 'telegram' | 'slack' | 'web' | string;

export type Attachment = {
  type: 'image' | 'file' | 'audio' | 'video' | 'location' | 'other';
  url?: string;
  bytesBase64?: string;
  mime?: string;
  filename?: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type MessageNormalized = {
  network: Network;
  conversationId: string;
  userId?: string;
  messageId: string;
  text?: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
  raw?: unknown;
};

export type ChatRoute = { network: Network; conversationId: string; userId?: string };

export type BridgeTaskInput = {
  route: ChatRoute;
  text?: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
  raw?: unknown;
};

export type ChatSender = {
  sendMessage(route: ChatRoute, text: string, options?: { parseMode?: 'plain' | 'markdown' | 'html' }): Promise<void>;
  sendTyping?(route: ChatRoute): Promise<void>;
  sendMedia?(route: ChatRoute, media: Attachment & { caption?: string }): Promise<void>;
  sendMarkup?(route: ChatRoute, markup: Markup): Promise<void>;
};

export type SessionState = 'idle' | 'running' | 'waitingInput';

export type SessionRecord = {
  key: string;                  // `${network}:${conversationId}`
  agentId: string;
  taskId: string;
  state: SessionState;
  token?: string;
  lastEventSeq?: number;
  lastActivityAt: number;
};

export type SessionStore = {
  get(key: string): Promise<SessionRecord | null>;
  upsert(rec: SessionRecord): Promise<void>;
  clear(key: string): Promise<void>;
};

export type AgentSelector = (msg: MessageNormalized, current: SessionRecord | null) => Promise<string>;

export type ChatEvent =
  | { type: 'reply'; taskId: string; seq: number; ts: string; text: string }
  | { type: 'progress'; taskId: string; seq: number; ts: string; pct?: number; status?: string }
  | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
  | { type: 'completed'; taskId: string; seq: number; ts: string; output?: unknown }
  | { type: 'error'; taskId: string; seq: number; ts: string; code?: string; message: string }
  | { type: 'media'; taskId: string; seq: number; ts: string; media: Attachment & { caption?: string } };

export type RealtimePublisher = { publish: (channelKey: string, event: ChatEvent) => Promise<void> };

export type ResultPayload =
  | { id: string; status: 'completed'; output: unknown }
  | { id: string; status: 'failed'; error: string }
  | { id: string; status: 'input_required'; token: string };

export type Invoker = {
  start: (params: { id: string; input: BridgeTaskInput; agentId: string; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
  resume: (params: { id: string; token: string; input: BridgeTaskInput; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
};

export type BridgeOptions = {
  sessionStore: SessionStore;
  agentSelector: AgentSelector;
  chatSender: ChatSender;
  invoker: Invoker;            // programmatic or JSON-RPC implementation
  realtime?: RealtimePublisher;
  timeouts?: { inputWaitMs?: number; typingThrottleMs?: number };
  tenantIdResolver?: (msg: MessageNormalized) => string;
};
```

## API

```ts
export type Bridge = {
  handleIncomingMessage(msg: MessageNormalized): Promise<void>;
};

export function createBridge(options: BridgeOptions): Bridge;
```

## Outbound message mapping (ctx.reply → chat)

The bridge listens to task streaming events and forwards parts to the configured `ChatSender`.

- **Text**: `MessagePart` with `type: 'text'` and optional `format: 'markdown' | 'html' | 'plain'`
  - `ctx.reply('Hello')` → defaults to Markdown
  - `ctx.reply({ type: 'text', text: '<b>Bold</b>', format: 'html' })` → HTML
  - Forwarded as `sendMessage(route, text, { parseMode })`

- **Images/Files/Audio/Video**: `type: 'image' | 'file' | 'audio' | 'video'`
  - Forwarded via `sendMedia(route, { type, url?, bytesBase64?, mime?, filename?, caption? })`
  - Images map to `{ kind: 'image' }`. Files map to a link-style fallback. Audio/Video map to a link-style text fallback.

- **Markup**: `type: 'markup'` and `value` is a Markup object (or JSON string)
  - Passed through to `sendMarkup(route, markup)`
  - Supported Markup union in this package:
    ```ts
    export type TextMarkup = { kind: 'text'; html?: string; markdown?: string };
    export type ImageMarkup = { kind: 'image'; url?: string; base64?: string; caption?: string };
    export type LocationMarkup = { kind: 'location'; lat: number; lng: number; name?: string; address?: string };
    export type ButtonsMarkup = { kind: 'buttons'; prompt?: string; buttons: Array<{ title: string; payload: unknown }> };
    export type Markup = TextMarkup | ImageMarkup | LocationMarkup | ButtonsMarkup;
    ```

### Examples from agents

```ts
// Text (Markdown default)
await ctx.reply('Hello **world**');

// Text (HTML)
await ctx.reply({ type: 'text', text: '<b>Bold</b> <i>italic</i>', format: 'html' });

// Image (URL)
await ctx.reply({ type: 'image', url: 'https://example.com/img.jpg', caption: 'A <b>cat</b>' });

// Location (via markup)
await ctx.reply({
  type: 'markup',
  value: { kind: 'location', lat: 56.9496, lng: 24.1052, name: 'Riga', address: 'Latvia' }
});

// Buttons (via markup)
await ctx.reply({
  type: 'markup',
  value: {
    kind: 'buttons',
    prompt: 'Choose an option:',
    buttons: [
      { title: 'Option 1', payload: { action: 'option1', data: 'any JSON data' } },
      { title: 'Option 2', payload: { action: 'option2', id: 123 } }
    ]
  }
});
```

## Usage (serverless webhook)

```ts
import { createBridge } from '@a2arium/callagent-chat-bridge';

const bridge = createBridge({ sessionStore, agentSelector, chatSender, invoker, realtime });

export async function handler(event) {
  const normalized = adapter.normalizeInbound(event.body);
  for (const msg of normalized) {
    await bridge.handleIncomingMessage(msg);
  }
  return { statusCode: 200, body: 'OK' };
}
```

### Accessing chat route inside agents

The task input now includes the chat route so agents can read the originating user/session metadata without additional lookups:

```ts
import type { TaskContext } from '@a2arium/callagent-core';
import type { BridgeTaskInput } from '@a2arium/callagent-chat-bridge';

export async function handleTask(ctx: TaskContext) {
  const input = ctx.task.input as BridgeTaskInput;
  const { route, text } = input;
  ctx.logger?.info?.('incoming-chat', {
    network: route.network,
    conversationId: route.conversationId,
    userId: route.userId,
    text
  });
  // ...continue agent logic
}
```

## Notes

- Key = `${network}:${conversationId}`; store `{ taskId, token, state }` for start/resume
- When `waitingInput`, next inbound message is treated as input (configurable)
- For WS live updates, publish `ChatEvent` to `channelKey = ${network}:${conversationId}`
- For tenant isolation, default `tenantId = network`

### Input Required + Parts/Markup
- `ctx.requestInput(...)` now accepts the same payloads as `ctx.reply` (strings, MessagePart(s), including `type:'markup'`).
- The bridge will have already received and forwarded any parts (text/media/markup) via artifacts before the `input_required` status resolves.
- The invoker omits the plain `prompt` string when parts were present to avoid duplicating messages.

## Session stores: Chat vs Working Memory

- Chat SessionStore (this package)
  - Purpose: router state for conversations (which agent, which task, waiting for input, etc.)
  - Keyed by: `key = ${network}:${conversationId}`
  - Fields: `agentId`, `taskId`, `state`, `token`, `lastEventSeq`, `lastActivityAt`
  - Lifecycle: transient; cleared on completion/cancel/timeout

- WorkingMemorySessionStore (core engine)
  - Purpose: durable per-task working memory snapshots/events/outbox
  - Keyed by: `tenantId + taskId`
  - Stores: WM snapshot (vars/LLM), CAS version, event log
  - Lifecycle: persists beyond chat mapping (audit/replay)

- Relationship
  - During a task lifetime, `ChatSession.taskId` points to the WM session for the same task (within the same `tenantId`).
  - Treat `taskId` as unique per tenant. If allowing multiple concurrent tasks per conversation, Chat SessionStore becomes 1:many.
