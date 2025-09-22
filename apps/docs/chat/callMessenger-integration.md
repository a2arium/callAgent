# callMessenger Integration

This shows how to wire callMessenger to the chat-bridge.

## Install

- Ensure Prisma models for ChatSession/ChatIdempotency exist and run migrations.
- Add @a2arium/callagent-chat-bridge to your repo (portal or package).

## Wiring

```ts
import { createCallMessenger } from '@callmessenger/core';
import {
  createBridge,
  PrismaSessionStore,
  getChatPrismaClient,
  createCallMessengerChatSender,
  normalizeFromCallMessengerEvent
} from '@a2arium/callagent-chat-bridge';

const cm = createCallMessenger({ /* https, telegram, web */ });

const bridge = createBridge({
  sessionStore: new PrismaSessionStore(getChatPrismaClient()),
  agentSelector: async () => 'your-agent',
  chatSender: createCallMessengerChatSender(cm),
  invoker: /* ProgrammaticInvoker instance */,
  timeouts: { inputWaitMs: 15 * 60 * 1000 },
  tenantIdResolver: (m) => m.network
});

cm.on('message.received', async (e) => {
  const m = normalizeFromCallMessengerEvent(e);
  if (m) await bridge.handleIncomingMessage(m);
});
cm.on('button.clicked', async (e) => {
  const m = normalizeFromCallMessengerEvent(e);
  if (m) await bridge.handleIncomingMessage(m);
});

await cm.listen();
```

## Notes

- Markup is supported: agents can emit a `markup` artifact part; the invoker forwards it via `sendMarkup` to callMessenger.
- Idempotency uses `messageId` per conversation key.
- Tenant defaults to network name; override in options if needed.

