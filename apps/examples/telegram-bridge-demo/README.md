# Telegram Bridge Demo

A minimal example showing how to wire callMessenger to the chat-bridge and route Telegram messages through the bridge.

## Prerequisites
- Node.js 20+
- Environment variables:
  - `CM_TG_BOT_TOKEN` – Telegram bot token
  - `CM_TG_WEBHOOK_PORT` – HTTPS port for Telegram webhook (e.g., 88)
  - `CHAT_DATABASE_URL` – Postgres URL for chat session/idempotency tables

## Setup
1) Ensure Prisma tables exist (in your main app DB):
- `ChatSession` and `ChatIdempotency` (see `packages/chat-bridge/prisma/schema.prisma`)

2) Install and build:
```bash
yarn install
yarn build
```

## Run
```bash
# export required envs
export CM_TG_BOT_TOKEN="<your-bot-token>"
export CM_TG_WEBHOOK_PORT=88
export CHAT_DATABASE_URL="postgres://user:pass@host:5432/dbname"

# start demo
yarn workspace @examples/telegram-bridge-demo run start
```

The demo:
- Starts callMessenger with HTTPS (self-signed TLS) and Telegram adapter
- Builds a bridge with Prisma-backed session store
- On incoming message, it replies with a buttons markup via the bridge

## Notes
- For local development, consider using ngrok if your environment requires a public URL.
- The example invoker is a placeholder that returns a buttons markup. Swap it with `ProgrammaticInvoker` for real agent execution.
- Input timeout and idempotency are handled by the bridge; schedule the sweepers if needed.
