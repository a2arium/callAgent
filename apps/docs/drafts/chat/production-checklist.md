# Production Checklist

## Env / Config
- CHAT_DATABASE_URL: Postgres URL for Prisma (ChatSession/ChatIdempotency)
- INPUT_WAIT_MS: Input timeout in ms (default: 900000 = 15m)
- IDEMPOTENCY_TTL_MS: TTL for idempotency entries in ms (default: 86400000 = 24h)
- ENABLE_REALTIME: 'true' to enable realtime publishing (default: off)
- ABLY_API_KEY: API key when realtime enabled (optional)

## Cron jobs
- Input-timeout sweeper: `apps/functions/sweep/chat-sessions.ts`
  - Run every 5-15 minutes to clear stale `waitingInput` sessions
- Idempotency cleanup: `apps/functions/sweep/idempotency.ts`
  - Run daily/hourly to prune old idempotency entries

Notes: Configure per platform (AWS Lambda + EventBridge, GCP Cloud Scheduler, Vercel/Netlify Cron).

## Logging & Metrics
- Pass a structured logger and metrics into `createBridge({... logger, metrics })`
- Recommended fields: { key, tenantId, taskId, messageId, agentId }

## Realtime (optional)
- Leave off by default. To enable, set `ENABLE_REALTIME=true` and `ABLY_API_KEY`
- Bridge publishes key lifecycle events when a publisher is provided

## Prisma
- Ensure `ChatSession` and `ChatIdempotency` exist and are migrated
- Co-locate tables with your existing schema if desired

## CallMessenger wiring
- Use `createCallMessengerChatSender(cm)` and `normalizeFromCallMessengerEvent(e)`
- (Optionally) use `createBridgeForCallMessenger(cm, createBridgeFn)` to auto-wire listeners
