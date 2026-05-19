# Streaming Live Viewer

Disposable manual review viewer for the runtime streaming migration.

This folder intentionally lives under `apps/docs/streaming-harness/` so it can
be deleted with the harness after streaming is promoted and reviewed. It is not
a supported product UI.

## Start The Reference Runtime Host

In another terminal:

```bash
yarn workspace @a2arium/runtime-host dev
```

Use this RPC URL in the viewer:

```text
http://127.0.0.1:8790/rpc
```

The reference host lives at `apps/examples/runtime-host/`. It is the canonical
local example of the shared runtime host shape; agents do not create servers.

## Start The Viewer

```bash
node apps/docs/streaming-harness/viewer/server.mjs
```

Open:

```text
http://127.0.0.1:8787
```

## Review Modes

- `tasks/sendSubscribe`: starts a task and streams the response.
- `tasks/resubscribe`: attaches to an existing task stream.
- `tasks/input`: sends input to a waiting task.
- Direct SSE URL: connects to any SSE endpoint through the same local proxy.

Use `visibility=debug` when the server supports canonical debug stream
projection. Public streams should hide tool, child, conversation, thought, and
decision events.

Default review values:

- RPC endpoint: `http://127.0.0.1:8790/rpc`
- Agent ID: `streaming-demo-agent`
- Task ID: any stable id, for example `viewer-task-1`
- Input JSON: `{ "text": "stream a demo" }`

## Expected Checks

- `artifact.done` appears when an artifact finishes, but the stream stays open.
- The stream closes only on terminal `task.status`.
- `ctx.progress(...)` appears as public non-terminal `task.status`.
- Debug visibility shows `tool.*`, `child.*`, conversation, goal, and decision
  events when the runtime produces them.
- Public visibility does not show debug/private events.
