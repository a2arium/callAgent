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

export type ChatSender = {
  sendMessage(route: ChatRoute, text: string, options?: { parseMode?: 'plain' | 'markdown' }): Promise<void>;
  sendTyping?(route: ChatRoute): Promise<void>;
  sendMedia?(route: ChatRoute, media: Attachment & { caption?: string }): Promise<void>;
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
  start: (params: { id: string; input: unknown; agentId: string; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
  resume: (params: { id: string; token: string; input: unknown; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
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

## Notes

- Key = `${network}:${conversationId}`; store `{ taskId, token, state }` for start/resume
- When `waitingInput`, next inbound message is treated as input (configurable)
- For WS live updates, publish `ChatEvent` to `channelKey = ${network}:${conversationId}`
- For tenant isolation, default `tenantId = network`

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
