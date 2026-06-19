#!/usr/bin/env node

const [, , taskId, tenantIdArg] = process.argv;

if (!taskId) {
  console.error('Usage: yarn operator:run-graph <taskId> [tenantId]');
  process.exit(1);
}

const tenantId = tenantIdArg ?? process.env.CALLAGENT_TENANT_ID ?? 'default';
const baseUrl = process.env.CALLAGENT_RUNTIME_URL ?? 'http://127.0.0.1:8790';
const url = new URL(`/tasks/${encodeURIComponent(taskId)}/run-graph`, baseUrl);

const response = await fetch(url, {
  headers: {
    'x-tenant-id': tenantId,
  },
});

const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}

if (!response.ok) {
  console.error(JSON.stringify({ status: response.status, body }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
