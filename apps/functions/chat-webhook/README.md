# Chat Webhook Function

Serverless entrypoint that receives normalized chat events and forwards them to the chat bridge. Intended to be used by your multi-network chat adapter.

## Responsibilities

- Accept inbound HTTP requests from the chat adapter
- Normalize payloads (or receive already normalized messages)
- Invoke `chat-bridge` to start or resume tasks
- Return 200 quickly; no long-lived connections

## Example

```ts
import { createBridge } from '@a2arium/callagent-chat-bridge';

// Provide concrete implementations
const sessionStore = /* ... */;
const agentSelector = async () => 'orchestrator-agent';
const chatSender = /* ... */;
const invoker = /* programmatic or JSON-RPC client */;

const bridge = createBridge({ sessionStore, agentSelector, chatSender, invoker });

export async function handler(event) {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    await bridge.handleIncomingMessage(msg);
  }
  return { statusCode: 200, body: 'OK' };
}
```
