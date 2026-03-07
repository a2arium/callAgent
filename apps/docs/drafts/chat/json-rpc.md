# JSON-RPC Endpoints

Serverless endpoints implementing `tasks/send` and `tasks/input` using JSON-RPC 2.0.

- URL: your function URL
- Request: `{ jsonrpc: '2.0', method: 'tasks/send'|'tasks/input', params: {...}, id }`
- Response: `{ jsonrpc: '2.0', result|error, id }`

See `apps/functions/rpc/index.ts` for reference implementation.
