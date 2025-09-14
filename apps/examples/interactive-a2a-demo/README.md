# Interactive A2A Demo

A minimal, purpose-built example showing:
- Non-blocking `requestInput(...).onProvided/.onExpired`
- Non-blocking `sendTaskToAgent(...).onInputRequired/.onCompleted`
- Group orchestration via `ctx.allTasks([...]).onAllCompleted/.onAnyFailed`
- Session-scoped WM and resumable flows

## Agents
- orchestrator: starts flow, requests region input, kicks off extractor+analyzer and joins
- extractor: returns rows
- analyzer: requests threshold and returns it

## Run
Use the JSON-RPC API:
1) Start orchestrator in streaming mode to see SSE:
```
POST /a2a/rpc { "jsonrpc":"2.0", "id":1, "method":"tasks/sendSubscribe", "params": { "id": "demo-1", "agent":"orchestrator" } }
```
2) When input is required, reply with tasks/input including Idempotency-Key:
```
POST /a2a/rpc { "jsonrpc":"2.0", "id":2, "method":"tasks/input", "params": { "id":"demo-1", "token":"<from event>", "input":"EU" } }
Idempotency-Key: abc123
```
3) If SSE connection drops, reconnect with Last-Event-ID header.
