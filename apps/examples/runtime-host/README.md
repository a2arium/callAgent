# Runtime Host Example

Reference local host for CallAgent contributors.

This is an example app, not a production server package. It demonstrates the
future production shape: one shared runtime host loads agents, owns `/rpc`, and
projects task streams for web/chat/CLI clients.

## Consumer startup

Consumers should not start this example. Create a CallAgent workspace, install
its dependencies, and run `npm run start`; that starts the installed runtime host,
Hatchet worker, and version-matched Observer. See
[CallAgent workspaces](../../docs/workspaces-and-runtime.md).

## Contributor debugging

From the repo root:

```bash
yarn runtime
```

This starts the runtime host, Hatchet worker, and operator dashboard together.
Infra is still started separately:

```bash
yarn hatchet:poc:up
```

For this example's host-only debugging, run:

```bash
yarn workspace @a2arium/runtime-host dev
```

The host prints:

```text
RPC URL: http://127.0.0.1:8790/rpc
Demo agent: streaming-demo-agent
```

External agent folders are configured through the workspace registry described
in `apps/docs/workspaces-and-runtime.md`.

Use that RPC URL in the temporary streaming viewer:

```bash
node apps/docs/streaming-harness/viewer/server.mjs
```

Open:

```text
http://127.0.0.1:8787
```

## Viewer Defaults

- RPC endpoint: `http://127.0.0.1:8790/rpc`
- Agent ID: `streaming-demo-agent`
- Method: `tasks/sendSubscribe`
- Visibility: `public` or `debug`

Example input:

```json
{
  "text": "stream a demo"
}
```

To exercise `input.required`:

```json
{
  "text": "please ask for input"
}
```

The demo agent emits:

- `ctx.progress(...)`
- artifact chunks via `ctx.reply(...)`
- `artifact.done` via `lastChunk`
- optional `input.required`
- goal/thought/decision debug/private events when available
- terminal task status via `ctx.complete()`

## Production Direction

Agents should not create servers. Production should provide a shared runtime
host or serverless adapter that owns:

- auth and tenant resolution
- agent registry/loading
- task protocol endpoints
- durable stores
- event transport
- stream visibility policy

This example is the Express/local version of that host shape.
